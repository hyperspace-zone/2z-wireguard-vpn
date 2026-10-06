let loading: Promise<void> | undefined;

export function loadMapAssets(): Promise<void> {
  return loading ??= Promise.all([loadAsset("leaflet.css", "style"), loadAsset("leaflet.js", "script")])
    .then(() => undefined).catch(error => { loading = undefined; throw error; });
}

export function loadAsset(name: string, kind: "style" | "script"): Promise<void> {
  const url = new URL(name, import.meta.url).href;
  return new Promise((resolve, reject) => {
    const element = kind === "style" ? document.createElement("link") : document.createElement("script");
    if (element instanceof HTMLLinkElement) { element.rel = "stylesheet"; element.href = url; }
    else { element.src = url; element.async = true; }
    const timer = window.setTimeout(() => { element.remove(); reject(new Error("Map asset timeout")); }, 10_000);
    element.onload = () => { window.clearTimeout(timer); resolve(); };
    element.onerror = () => { window.clearTimeout(timer); element.remove(); reject(new Error("Asset unavailable")); };
    document.head.appendChild(element);
  });
}
