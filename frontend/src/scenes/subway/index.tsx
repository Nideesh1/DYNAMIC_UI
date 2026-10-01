import { Hud } from "../shared/Hud";
import { useSceneSetup } from "../shared/useSceneSetup";

// placeholder — the subway scene is being built
export default function Scene() {
  useSceneSetup();
  return (
    <div className="scene-root">
      <Hud title="subway" subtitle="scene under construction" />
    </div>
  );
}
