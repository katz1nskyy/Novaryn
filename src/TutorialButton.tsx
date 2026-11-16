import { ArrowRight, BookOpen } from "lucide-react";
import "./tutorial-launch.css";

export default function TutorialButton({
  onClick,
  firstVisit,
}: {
  onClick: () => void;
  firstVisit: boolean;
}) {
  return (
    <span className="tutorial-launch">
      {firstVisit && (
        <ArrowRight className="tutorial-launch-arrow" size={20} aria-hidden="true" />
      )}
      <button
        type="button"
        className="tutorial-launch-button"
        onClick={onClick}
        aria-haspopup="dialog"
      >
        <BookOpen size={15} aria-hidden="true" />
        Start tutorial
      </button>
    </span>
  );
}
