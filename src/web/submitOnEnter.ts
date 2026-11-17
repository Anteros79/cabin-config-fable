import type { FormEvent, KeyboardEvent } from "react";

/** Inputs where ArrowUp or ArrowDown was pressed since the last input event: a suggestion may be highlighted. */
const browsingSuggestions = new WeakSet<HTMLInputElement>();

/**
 * Enter submits the input's form at once. For an input with a datalist, WebKit lets the suggestion picker take the
 * first Enter whenever the text matches a suggestion's value or label, so the form would not submit until a second
 * Enter; the browser's own Enter handling is cancelled and the form is submitted once in every browser.
 *
 * The one exception: after ArrowUp or ArrowDown in the input (and no typing since), Enter is left to the browser so it
 * can accept the highlighted suggestion. Cancelling that Enter would submit the half-typed text instead. Typing (an
 * input event, see `forgetSuggestionKeys`) ends the exception, and so does the browser filling in the accepted
 * suggestion, so the next Enter submits it.
 *
 * An input method's Enter is left alone too: it confirms the composed text. Safari reports some of those with
 * keyCode 229 and isComposing false.
 *
 * Use as the input's onKeyDown, together with `forgetSuggestionKeys` as its onInput.
 */
export function submitOnEnter(e: KeyboardEvent<HTMLInputElement>): void {
  const el = e.currentTarget;
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    browsingSuggestions.add(el);
    return;
  }
  if (e.key !== "Enter" || e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
  if (browsingSuggestions.has(el)) return;
  e.preventDefault();
  el.form?.requestSubmit();
}

/** The input's onInput for `submitOnEnter`: the text changed, so no suggestion is being picked with the arrow keys. */
export function forgetSuggestionKeys(e: FormEvent<HTMLInputElement>): void {
  browsingSuggestions.delete(e.currentTarget);
}
