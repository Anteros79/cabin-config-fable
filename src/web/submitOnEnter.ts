import type { KeyboardEvent } from "react";

/**
 * Enter submits the input's form at once. For an input with a datalist, WebKit lets the suggestion picker take the
 * first Enter when the text matches a suggestion, so the form would not submit until a second Enter. The browser's own
 * Enter handling is cancelled, so the form is submitted once in every browser. An input method's Enter (composing) is
 * left alone: it confirms the composed text.
 */
export function submitOnEnter(e: KeyboardEvent<HTMLInputElement>): void {
  if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
  e.preventDefault();
  e.currentTarget.form?.requestSubmit();
}
