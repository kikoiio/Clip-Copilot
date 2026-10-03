import { PHASE_LABELS } from "../labels.ts";
import type { Phase } from "../types.ts";

export function PhaseTimeline({ phase }: { phase: Phase }) {
  const order: Phase[] = ["assets", "score_draft", "score_review", "video_draft", "video_review", "final_verify", "done"];
  const currentIndex = order.indexOf(phase);
  return (
    <ol className="timeline">
      {order.map((step, index) => (
        <li key={step} className={index < currentIndex ? "done" : index === currentIndex ? "current" : ""}>
          {PHASE_LABELS[step]}
        </li>
      ))}
    </ol>
  );
}
