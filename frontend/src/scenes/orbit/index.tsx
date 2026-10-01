import { Hud } from "../shared/Hud";
import { useSceneSetup } from "../shared/useSceneSetup";

// placeholder — the orbit scene is being built
export default function Scene() {
  useSceneSetup();
  return (
    <div className="scene-root">
      <Hud title="orbit" subtitle="scene under construction" />
    </div>
  );
}
