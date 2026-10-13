#!/usr/bin/env python3
"""Real AWG client -> ingress -> kernel WG egress -> HTTP destination smoke test.

Requires iproute2, nftables, node, Go, and separately built upstream awg,
amneziawg-go (3.1+) and wg binaries. No downloads or package installation.
Runs entirely in private user/mount/network namespaces. Uses the upstream
userspace AWG implementation for ingress when the host has no AWG kernel module;
the only adapter substitutes AWG link creation. All configuration, packet
exchange, routes, firewall, readback and counters use the real tools/agent code.
"""
import argparse
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import time


def run(*args, **kwargs):
    return subprocess.run(args, check=True, text=True, **kwargs)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--awg", required=True, type=Path)
    parser.add_argument("--awg-go", required=True, type=Path)
    parser.add_argument("--wg", required=True, type=Path)
    parser.add_argument("--go", default="go")
    parser.add_argument("--client-protocol", choices=("wireguard", "amneziawg"), default="amneziawg")
    parser.add_argument("--isolated", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args()
    if not args.isolated:
        env = {**os.environ, "HYPERSPACE_TEST_PARENT_NETNS": os.readlink("/proc/self/ns/net"),
               "HYPERSPACE_TEST_PARENT_MNTNS": os.readlink("/proc/self/ns/mnt")}
        return subprocess.call(["unshare", "--user", "--map-root-user", "--mount", "--net",
                                sys.executable, str(Path(__file__).resolve()), *sys.argv[1:], "--isolated"], env=env)
    for kind in ("net", "mnt"):
        parent = os.environ.get("HYPERSPACE_TEST_PARENT_" + kind.upper() + "NS")
        if not parent or parent == os.readlink("/proc/self/ns/" + kind):
            raise RuntimeError("refusing to run outside private network/mount namespaces")
    os.umask(0o077)
    run("mount", "--make-rprivate", "/")
    run("mount", "-t", "tmpfs", "tmpfs", "/run")
    repo = Path(__file__).resolve().parents[2]
    ip = shutil.which("ip")
    namespaces = []
    with tempfile.TemporaryDirectory(prefix="hyperspace-awg-netns-") as directory:
        root = Path(directory)
        bins = root / "bin"
        bins.mkdir()
        for name, path in (("awg", args.awg), ("wg", args.wg), ("amneziawg-go", args.awg_go)):
            (bins / name).symlink_to(path.resolve())
        env = {**os.environ, "PATH": str(bins) + ":" + os.environ["PATH"],
               "SMOKE_ROOT": str(root), "SMOKE_REPO": str(repo), "HYPERSPACE_AWG_FIXTURE": str(root),
               "SMOKE_CLIENT_PROTOCOL": args.client_protocol,
               "WG_PROCESS_FOREGROUND": "1", "LOG_LEVEL": "error"}
        test_binary = root / "gate.test"
        run(args.go, "test", "-c", "-o", str(test_binary), "./cmd/hyperspace-gate-agent", cwd=repo / "apps/gate-agent", env=env)
        # Exercise the real control-plane renderer, including encrypted secrets.
        run("node", "--input-type=module", "-e", r'''
import { writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
const root = process.env.SMOKE_ROOT, repo = process.env.SMOKE_REPO;
const { renderWireGuardPlan } = await import(pathToFileURL(repo + '/packages/control-plane/dist/planning/render-plan.js'));
const { renderClientConfig } = await import(pathToFileURL(repo + '/packages/control-plane/dist/resources/artifacts/client-config.js'));
const { decryptJsonPayload } = await import(pathToFileURL(repo + '/packages/shared/dist/index.js'));
const pair = () => { const key = execFileSync('wg', ['genkey'], {encoding:'utf8'}).trim(); return {key, pub:execFileSync('wg', ['pubkey'], {input:key+'\n', encoding:'utf8'}).trim()}; };
const server = pair(), transitIn = pair(), transitOut = pair(), encryptionKey = Buffer.alloc(32, 9);
const spec = process.env.SMOKE_CLIENT_PROTOCOL === 'amneziawg' ? {clientProtocol:'amneziawg'} : {};
const rendered = renderWireGuardPlan({id:'smoke',generation:1,mode:'IpToIp',destinationCidrs:['203.0.113.42/32'],sourceCidr:null,clientPublicKey:null,spec},
  {ingressGateId:'in',ingressGateName:'in',ingressPublicIpv4:'192.0.2.1',egressGateId:'out',egressGateName:'out',egressPublicIpv4:'192.0.2.2'}, '10.42.0.2/32', encryptionKey);
const secret = decryptJsonPayload(rendered.secretPayload, encryptionKey);
const materialIn = {assignmentId:'in',role:'Ingress',handle:'hs-assignment-in',clientTunnel:rendered.publicMaterial.clientTunnel,
  interfaces:{client:'hsc-smoke',transit:'hsti-smoke'},wireGuard:{clientPublicKey:server.pub,clientListenPort:51820,transitPublicKey:transitIn.pub,transitListenPort:51821}};
const materialOut = {assignmentId:'out',role:'Egress',handle:'hs-assignment-out',interfaces:{transit:'hste-smoke'},wireGuard:{transitPublicKey:transitOut.pub,transitListenPort:51822}};
const state = (role,material,key) => ({assignmentId:material.assignmentId,role,handle:material.handle,sessionId:'smoke',clientAddress:'10.42.0.2/32',destinationCidrs:['203.0.113.42/32'],routingTable:20000,rulePriority:10000,transitPrivateKey:key,material});
const ingress = {...state('Ingress',materialIn,transitIn.key),clientPrivateKey:server.key,headerProtectionKey:secret.headerProtectionKey};
const egress = state('Egress',materialOut,transitOut.key);
const plan = {planId:'plan',sessionId:'smoke',generation:1,publicMaterial:rendered.publicMaterial,
 ingress:{role:'Ingress',publicIpv4:'192.0.2.1',localMaterial:materialIn},egress:{role:'Egress',publicIpv4:'192.0.2.2',localMaterial:materialOut}};
writeFileSync(root+'/fixture.json', JSON.stringify({ingress,egress,plan}), {mode:0o600});
writeFileSync(root+'/client.conf',renderClientConfig({privateKey:secret.clientPrivateKey,clientPublicKey:rendered.publicMaterial.clientPublicKey,clientKeyMode:'ServerGenerated',address:'10.42.0.2/32',serverPublicKey:server.pub,endpoint:'192.0.2.1:51820',allowedIps:['203.0.113.42/32'],persistentKeepaliveSeconds:25,mtu:rendered.publicMaterial.mtu??1420,clientTunnel:rendered.publicMaterial.clientTunnel,headerProtectionKey:secret.headerProtectionKey}),{mode:0o600});
''', cwd=repo, env=env)
        # extended WireGuard link-creation adapter only; every other ip command is passed through.
        adapter = root / "adapter"
        adapter.mkdir()
        (adapter / "ip").write_text(f'''#!{sys.executable}
import os, subprocess, sys, time
a=sys.argv[1:]
if len(a)==6 and a[:3]==['link','add','dev'] and a[4:]==['type','amneziawg']:
    name=a[3]
    with open(os.environ['SMOKE_ROOT']+'/'+name+'.log','a') as log:
        p=subprocess.Popen(['amneziawg-go','-f',name], stdout=log, stderr=log)
    for _ in range(100):
        if p.poll() is not None: sys.exit(1)
        if os.path.exists('/run/amneziawg/'+name+'.sock'): sys.exit(0)
        time.sleep(.02)
    p.terminate(); sys.exit(1)
os.execv({ip!r},[{ip!r}]+a)
''')
        (adapter / "ip").chmod(0o700)
        ingress_env = {**env, "PATH": str(adapter) + ":" + env["PATH"]}

        def ns(name, *cmd, **kwargs):
            return run(ip, "netns", "exec", name, *cmd, env=kwargs.pop("env", env), **kwargs)

        def agent(role, action):
            ns("ingress" if role == "Ingress" else "egress", str(test_binary),
               "-test.run=^TestAmneziaWGMixedPathIntegration$", "-test.v",
               env={**(ingress_env if role == "Ingress" else env), "HYPERSPACE_AWG_ROLE": role, "HYPERSPACE_AWG_ACTION": action})

        try:
            run(ip, "link", "add", "br-test", "type", "bridge")
            run(ip, "addr", "add", "192.0.2.254/24", "dev", "br-test")
            run(ip, "link", "set", "br-test", "up")
            for name, number in (("ingress", 1), ("egress", 2), ("client", 3), ("target", 4)):
                run(ip, "netns", "add", name)
                namespaces.append(name)
                run(ip, "link", "add", "v-" + name, "type", "veth", "peer", "name", "eth0", "netns", name)
                run(ip, "link", "set", "v-" + name, "master", "br-test")
                run(ip, "link", "set", "v-" + name, "up")
                ns(name, ip, "link", "set", "lo", "up")
                ns(name, ip, "link", "set", "eth0", "up")
                ns(name, ip, "addr", "add", f"192.0.2.{number}/24", "dev", "eth0")
                ns(name, ip, "route", "add", "default", "via", "192.0.2.254")
            ns("target", ip, "addr", "add", "203.0.113.42/32", "dev", "lo")
            ns("egress", ip, "route", "add", "203.0.113.42/32", "via", "192.0.2.4")
            if args.client_protocol == "amneziawg":
                agent("Ingress", "probe")
            agent("Egress", "apply")
            agent("Ingress", "apply")
            ns("client", str(adapter / "ip"), "link", "add", "dev", "awc-smoke", "type", args.client_protocol)
            config = (root / "client.conf").read_text()
            (root / "client-stripped.conf").write_text("\n".join(line for line in config.splitlines() if not line.startswith(("Address =", "DNS =", "MTU ="))))
            ns("client", "awg" if args.client_protocol == "amneziawg" else "wg", "setconf", "awc-smoke", str(root / "client-stripped.conf"))
            ns("client", ip, "addr", "add", "10.42.0.2/32", "dev", "awc-smoke")
            ns("client", ip, "link", "set", "awc-smoke", "mtu", "1280" if args.client_protocol == "amneziawg" else "1420", "up")
            ns("client", ip, "route", "add", "203.0.113.42/32", "dev", "awc-smoke")
            server = r'''
from http.server import BaseHTTPRequestHandler, HTTPServer
from socketserver import TCPServer
class Server(HTTPServer):
 def server_bind(self):
  TCPServer.server_bind(self)
  self.server_name='target'; self.server_port=self.server_address[1]
class Handler(BaseHTTPRequestHandler):
 def do_GET(self):
  data=(self.client_address[0]+'\n'+'x'*32768).encode()
  self.send_response(200); self.send_header('Content-Length',str(len(data))); self.end_headers(); self.wfile.write(data)
 def log_message(self,*args): pass
Server(('203.0.113.42',8080),Handler).serve_forever()
'''
            with open(root / "http.log", "w") as log:
                server_process = subprocess.Popen([ip, "netns", "exec", "target", sys.executable, "-c", server], env=env, stdout=log, stderr=log)
            ns("target", sys.executable, "-c", "import socket,time\nfor _ in range(100):\n try:\n  socket.create_connection(('203.0.113.42',8080),timeout=.1).close(); break\n except OSError: time.sleep(.05)\nelse: raise RuntimeError('HTTP server did not start')")
            if server_process.poll() is not None:
                raise RuntimeError("HTTP server exited: " + (root / "http.log").read_text())
            request = r'''
import urllib.request
opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
data=opener.open('http://203.0.113.42:8080',timeout=45).read()
assert data == b'192.0.2.2\n'+b'x'*32768, 'incorrect egress IP or corrupted payload'
print('HTTP payload and egress NAT address verified')
'''
            ns("client", sys.executable, "-c", request)
            agent("Ingress", "check")
            agent("Egress", "check")
            ns("ingress", ip, "link", "del", "hsc-smoke")
            ns("ingress", ip, "link", "del", "hsti-smoke")
            time.sleep(.2)
            agent("Ingress", "restore")
            ns("client", sys.executable, "-c", request)
            agent("Ingress", "revoke")
            result = subprocess.run([ip, "netns", "exec", "client", sys.executable, "-c", request.replace("timeout=45", "timeout=2")], env=env, capture_output=True)
            if result.returncode == 0:
                raise RuntimeError("revoked tunnel still forwards traffic")
            agent("Egress", "revoke")
            print(f"PASS: real {args.client_protocol} client / WireGuard transit, NAT, counters, restore and revoke")
        except Exception:
            for name in namespaces:
                for cmd in (("wg", "show", "all", "transfer"), ("awg", "show", "all", "transfer"),
                            (ip, "route", "show", "table", "all"), ("nft", "list", "ruleset")):
                    subprocess.run([ip, "netns", "exec", name, *cmd], env=env, check=False)
            print((root / "http.log").read_text() if (root / "http.log").exists() else "HTTP server not started")
            raise
        finally:
            for name in namespaces:
                result = subprocess.run([ip, "netns", "pids", name], capture_output=True, text=True)
                for pid in result.stdout.split():
                    try: os.kill(int(pid), signal.SIGTERM)
                    except ProcessLookupError: pass
                subprocess.run([ip, "netns", "del", name], capture_output=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
