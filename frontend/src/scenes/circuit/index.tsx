import { Hud } from "../shared/Hud";
import { useSceneSetup } from "../shared/useSceneSetup";

// placeholder — the circuit scene is being built
export default function Scene() {
  useSceneSetup();
  return (
    <div className="scene-root">
      <Hud title="circuit" subtitle="scene under construction" />
    </div>
  );
}
