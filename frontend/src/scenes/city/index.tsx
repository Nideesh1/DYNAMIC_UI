import { Hud } from "../shared/Hud";
import { useSceneSetup } from "../shared/useSceneSetup";

// placeholder — the city scene is being built
export default function Scene() {
  useSceneSetup();
  return (
    <div className="scene-root">
      <Hud title="city" subtitle="scene under construction" />
    </div>
  );
}
