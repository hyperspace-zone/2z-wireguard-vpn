import hashlib
import importlib.machinery
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import unittest

loader = importlib.machinery.SourceFileLoader("r2", str(Path(__file__).with_name("hyperspace-r2-objects")))
spec = importlib.util.spec_from_loader(loader.name, loader)
r2 = importlib.util.module_from_spec(spec)
loader.exec_module(r2)


class Missing(Exception):
    response = {"Error": {"Code": "404"}}


class Forbidden(Exception):
    response = {"Error": {"Code": "403"}}


class FakeS3:
    def __init__(self):
        self.objects = {}
        self.events = []
        self.corrupt = False

    def head_object(self, Bucket, Key):
        if Key not in self.objects:
            raise Missing()
        data, meta = self.objects[Key]
        return {"ContentLength": len(data), "Metadata": meta}

    def get_object(self, Bucket, Key):
        data, meta = self.objects[Key]
        return {"Body": io.BytesIO(b"corrupt" if self.corrupt else data), "Metadata": meta}

    def put_object(self, Bucket, Key, Body, **kw):
        self.objects[Key] = (Body, kw.get("Metadata", {}))
        self.events.append(("put", Key))

    def upload_file(self, file, bucket, key, ExtraArgs, Config):
        self.put_object(bucket, key, Path(file).read_bytes(), Metadata=ExtraArgs["Metadata"])

    def delete_object(self, Bucket, Key):
        self.objects.pop(Key, None)
        self.events.append(("delete", Key))

    def get_paginator(self, _):
        return self

    def paginate(self, Bucket, Prefix):
        yield {"Contents": [{"Key": key} for key in self.objects if key.startswith(Prefix)]}


class Tests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.client = FakeS3()
        self.store = r2.Store(self.client, "test")
        os.environ["HS_R2_BACKUP_PREFIX"] = "backups/mainnet/hyperspace"

    def bundle(self, stamp):
        path = self.root / f"hyperspace-{stamp}.dump"
        path.write_bytes(b"custom-format-dump")
        Path(str(path) + ".sha256").write_text(r2.digest(path))
        (self.root / f"hyperspace-globals-{stamp}.sql").write_text("roles reference")
        return path

    def test_commit_last_and_restore(self):
        (self.root / "data").write_bytes(b"hello")
        self.store.publish(self.root, "history/day")
        self.assertEqual(self.client.events[-1], ("put", "history/day/_VERIFIED.json"))
        target = self.root / "restore"
        self.store.fetch("history/day", target)
        self.assertEqual((target / "data").read_bytes(), b"hello")

    def test_corrupt_readback_never_commits(self):
        (self.root / "data").write_bytes(b"hello")
        self.client.corrupt = True
        with self.assertRaises(ValueError):
            self.store.publish(self.root, "history/day")
        self.assertNotIn("history/day/_VERIFIED.json", self.client.objects)

    def test_immutable_collision(self):
        (self.root / "data").write_bytes(b"first")
        self.store.publish(self.root, "history/day")
        (self.root / "data").write_bytes(b"second")
        with self.assertRaises(ValueError):
            self.store.publish(self.root, "history/day")
        self.assertEqual(self.client.objects["history/day/data"][0], b"first")

    def test_forbidden_is_not_missing(self):
        self.client.head_object = lambda **kw: (_ for _ in ()).throw(Forbidden())
        with self.assertRaises(Forbidden):
            self.store.fetch("history/day", self.root, optional=True)

    def test_missing_optional_allows_new_archive(self):
        self.assertIsNone(self.store.fetch("history/day", self.root, optional=True))

    def test_bad_manifest_path_is_rejected(self):
        raw = json.dumps({"version": 1, "files": {"../escape": {"sha256": "0" * 64, "size": 0}}}).encode()
        self.client.put_object("test", "history/day/_VERIFIED.json", raw, Metadata={"sha256": hashlib.sha256(raw).hexdigest()})
        with self.assertRaises(ValueError):
            self.store.fetch("history/day", self.root)

    def test_retention_preserves_legacy_and_newest(self):
        self.client.put_object("test", "legacy/manual.dump", b"manual")
        for day in range(1, 5):
            self.store.backup(self.bundle(f"2026100{day}T010000Z"), 3)
        versions = self.store.backup_generations("backups/mainnet/hyperspace", "hyperspace")
        self.assertEqual([v[0] for v in versions], [f"2026100{day}T010000Z" for day in range(2, 5)])
        self.assertIn("legacy/manual.dump", self.client.objects)
        first_delete = next(i for i, e in enumerate(self.client.events) if e[0] == "delete")
        commit = self.client.events.index(("put", "backups/mainnet/hyperspace/20261004T010000Z/_VERIFIED.json"))
        self.assertGreater(first_delete, commit)

    def test_failed_new_backup_does_not_prune(self):
        for day in range(1, 4):
            self.store.backup(self.bundle(f"2026100{day}T010000Z"), 3)
        self.client.corrupt = True
        with self.assertRaises(ValueError):
            self.store.backup(self.bundle("20261004T010000Z"), 3)
        self.assertFalse(any(e[0] == "delete" for e in self.client.events))

    def test_local_symlink_rejected(self):
        (self.root / "unsafe").symlink_to("/etc/passwd")
        with self.assertRaises(ValueError):
            self.store.publish(self.root, "history/day")

    def archive_fixture(self, complete=True):
        day = self.root / "day"
        day.mkdir()
        data = day / "jobs.jsonl.zst"
        data.write_bytes(b"compressed fixture")
        Path(str(data) + ".sha256").write_text(r2.digest(data) + "  jobs.jsonl.zst\n")
        (day / "READY").write_text("1")
        (day / "MANIFEST").write_text("fixture")
        if complete:
            (day / "COMPLETE").write_text("2")
        return day

    def test_archive_spool_evicted_only_after_complete_remote_verification(self):
        day = self.archive_fixture()
        self.store.archive(day, "history-archive/mainnet/jobs/2026-09-01", clean=True)
        self.assertFalse(day.exists())
        self.assertIn("history-archive/mainnet/jobs/2026-09-01/COMPLETE", self.client.objects)

    def test_archive_failed_readback_preserves_every_local_file(self):
        day = self.archive_fixture()
        before = set(day.iterdir())
        self.client.corrupt = True
        with self.assertRaises(ValueError):
            self.store.archive(day, "history-archive/mainnet/jobs/2026-09-01", clean=True)
        self.assertEqual(set(day.iterdir()), before)

    def test_archive_unfinished_day_cannot_be_evicted(self):
        day = self.archive_fixture(complete=False)
        with self.assertRaises(ValueError):
            self.store.archive(day, "history-archive/mainnet/jobs/2026-09-01", clean=True)
        self.assertTrue((day / "jobs.jsonl.zst").is_file())

    def test_archive_local_checksum_mismatch_fails_before_upload(self):
        day = self.archive_fixture()
        (day / "jobs.jsonl.zst").write_bytes(b"broken")
        with self.assertRaises(ValueError):
            self.store.archive(day, "history-archive/mainnet/jobs/2026-09-01")
        self.assertEqual(self.client.events, [])

    def test_corrupt_download_does_not_replace_existing_local_file(self):
        (self.root / "data").write_bytes(b"hello")
        self.store.publish(self.root, "history/day")
        target = self.root / "restore"
        target.mkdir()
        (target / "data").write_bytes(b"previous")
        # Fetch validates the manifest first; corrupt data only, not manifest.
        raw, meta = self.client.objects["history/day/data"]
        self.client.objects["history/day/data"] = (b"wrong", meta)
        with self.assertRaises(ValueError):
            self.store.fetch("history/day", target)
        self.assertEqual((target / "data").read_bytes(), b"previous")


if __name__ == "__main__":
    unittest.main()
