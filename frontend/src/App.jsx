import React, { useCallback, useEffect, useState } from "react";
import BootOverlay from "./components/BootOverlay";
import HeaderBar from "./components/HeaderBar";
import Tabs from "./components/Tabs";
import ImageSection from "./components/ImageSection";
import VideoSection from "./components/VideoSection";
import SettingsPanel from "./components/SettingsPanel";
import { cleanUrl, defaultBackend, getStored } from "./utils";

function App() {
  const [activeTab, setActiveTab] = useState("image");
  const [backendUrl, setBackendUrl] = useState(() => getStored("lucidframe.backend", defaultBackend));

  const [modelDir, setModelDir] = useState(() => getStored("lucidframe.modeldir", "models/"));
  const [ffmpegPath, setFfmpegPath] = useState(() => getStored("lucidframe.ffmpeg", "bin/ffmpeg.exe"));
  const [tileSize, setTileSize] = useState(() => getStored("lucidframe.tile", "256"));
  const [useFp16, setUseFp16] = useState(() => getStored("lucidframe.fp16", "true") === "true");
  const [health, setHealth] = useState({ status: "unknown", device: "", version: "" });
  const [healthLoading, setHealthLoading] = useState(true);

  useEffect(() => {
    localStorage.setItem("lucidframe.backend", backendUrl);
  }, [backendUrl]);

  useEffect(() => {
    localStorage.setItem("lucidframe.modeldir", modelDir);
  }, [modelDir]);

  useEffect(() => {
    localStorage.setItem("lucidframe.ffmpeg", ffmpegPath);
  }, [ffmpegPath]);

  useEffect(() => {
    localStorage.setItem("lucidframe.tile", tileSize);
  }, [tileSize]);

  useEffect(() => {
    localStorage.setItem("lucidframe.fp16", String(useFp16));
  }, [useFp16]);

  const fetchHealth = useCallback(async () => {
    setHealthLoading(true);
    try {
      const res = await fetch(`${cleanUrl(backendUrl)}/health`);
      if (!res.ok) throw new Error("health failed");
      const data = await res.json();
      setHealth({ status: "ok", device: data.device, version: data.version, amp: data.amp, half: data.half });
    } catch (err) {
      setHealth({ status: "unreachable", device: "", version: "" });
    } finally {
      setHealthLoading(false);
    }
  }, [backendUrl]);

  useEffect(() => {
    fetchHealth();
  }, [fetchHealth, backendUrl]);

  const ready = !healthLoading && health.status === "ok";

  if (!ready) {
    return (
      <div className="page">
        <BootOverlay
          show
          status={health.status}
          backendUrl={backendUrl}
          onBackendChange={setBackendUrl}
          onRefresh={fetchHealth}
          healthLoading={healthLoading}
        />
      </div>
    );
  }

  return (
    <div className="page">
      <div className="chrome" aria-busy={!ready}>
        <HeaderBar
          backendUrl={backendUrl}
          onBackendChange={setBackendUrl}
          onRefresh={fetchHealth}
          healthLoading={healthLoading}
        />

        <Tabs activeTab={activeTab} onChange={setActiveTab} />

        {activeTab === "image" && <ImageSection backendUrl={backendUrl} warmup={healthLoading} />}
        {activeTab === "video" && <VideoSection backendUrl={backendUrl} />}

        <SettingsPanel
          modelDir={modelDir}
          ffmpegPath={ffmpegPath}
          tileSize={tileSize}
          useFp16={useFp16}
          onModelDir={setModelDir}
          onFfmpegPath={setFfmpegPath}
          onTileSize={setTileSize}
          onFp16={setUseFp16}
          health={health}
        />
      </div>
    </div>
  );
}

export default App;
