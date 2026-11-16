import type { ReactNode } from "react";

/** What a list shows when it has nothing to list: what is missing, why if it helps, and the next step. */
export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: { label: string; href: string } }) {
  return (
    <div className="empty-state">
      <p className="empty-title">{title}</p>
      {children}
      {action && (
        <p>
          <a className="button" href={action.href}>
            {action.label}
          </a>
        </p>
      )}
    </div>
  );
}
