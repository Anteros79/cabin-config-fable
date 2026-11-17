import type { KeyboardEvent } from "react";

/**
 * Enter submits the input's form at once when the text is exactly one of the input's datalist suggestions (ignoring
 * case and surrounding spaces). WebKit lets the suggestion picker take the first Enter for such a text, so the form
 * would not submit until a second Enter; for that case the browser's own Enter handling is cancelled and the form is
 * submitted once in every browser.
 *
 * Any other text, and an input without a list, keeps the browser's Enter: in WebKit, ArrowDown then Enter accepts the
 * highlighted suggestion, and cancelling that Enter would submit the half-typed text instead of the suggestion.
 * An input method's Enter is left alone too: it confirms the composed text. Safari reports some of those with
 * keyCode 229 and isComposing false.
 */
export function submitOnEnter(e: KeyboardEvent<HTMLInputElement>): void {
  if (e.key !== "Enter" || e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
  const el = e.currentTarget;
  const typed = el.value.trim().toUpperCase();
  if (!Array.from(el.list?.options ?? []).some((o) => o.value.toUpperCase() === typed)) return;
  e.preventDefault();
  el.form?.requestSubmit();
}
