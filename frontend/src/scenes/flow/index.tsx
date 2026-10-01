import { Hud } from "../shared/Hud";
import { useSceneSetup } from "../shared/useSceneSetup";

// placeholder — the flow scene is being built
export default function Scene() {
  useSceneSetup();
  return (
    <div className="scene-root">
      <Hud title="flow" subtitle="scene under construction" />
    </div>
  );
}
