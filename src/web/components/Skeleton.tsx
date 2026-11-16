/** The shapes a view can stand in for while it loads; each is sized like the content it replaces. */
export type SkeletonShape = "workspace" | "report" | "table" | "facts";

const ROWS = 6;

/**
 * Grey blocks where content is about to appear, inside the panel that will hold it. The blocks are hidden from
 * assistive technology; one visually hidden line says what is loading. The panel around it sets `aria-busy`.
 */
export function Skeleton({ thing, shape }: { thing: string; shape: SkeletonShape }) {
  return (
    <>
      <p className="sr-only" role="status">
        Loading {thing}
      </p>
      <div className={`skeleton skeleton-${shape}`} aria-hidden="true" data-skeleton={shape}>
        {shape === "workspace" && (
          <>
            <div className="sk-block sk-line sk-wide" />
            <div className="sk-row">
              <div className="sk-block sk-canvas" />
              <div className="sk-side">
                <div className="sk-block sk-heading" />
                <div className="sk-block sk-line" />
                <div className="sk-block sk-line sk-short" />
                <div className="sk-block sk-line" />
              </div>
            </div>
          </>
        )}
        {shape === "report" && (
          <>
            <div className="sk-block sk-heading sk-wide" />
            <div className="sk-block sk-line" />
            <Facts />
            <Table />
          </>
        )}
        {shape === "table" && <Table />}
        {shape === "facts" && <Facts />}
      </div>
    </>
  );
}

function Facts() {
  return (
    <div className="sk-facts">
      {Array.from({ length: 4 }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: fixed placeholders, never reordered
        <div key={i} className="sk-block sk-line" />
      ))}
    </div>
  );
}

function Table() {
  return (
    <div className="sk-table">
      <div className="sk-block sk-table-head" />
      {Array.from({ length: ROWS }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: fixed placeholders, never reordered
        <div key={i} className="sk-block sk-table-row" />
      ))}
    </div>
  );
}
