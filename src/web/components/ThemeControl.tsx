import { useState } from "react";
import { chooseTheme, storedTheme, type ThemeChoice } from "../theme.ts";

const CHOICES: [ThemeChoice, string][] = [
  ["system", "System"],
  ["light", "Light"],
  ["dark", "Dark"],
];

/** The header's theme control (WEB-16): follow the system, or choose light or dark. The choice is kept for next time. */
export function ThemeControl() {
  const [choice, setChoice] = useState<ThemeChoice>(storedTheme);
  return (
    // biome-ignore lint/a11y/useSemanticElements: a group of toggle buttons, not a form fieldset
    <div className="theme-switch" role="group" aria-label="Colour theme">
      {CHOICES.map(([value, label]) => (
        <button
          key={value}
          type="button"
          aria-pressed={choice === value}
          onClick={() => {
            chooseTheme(value);
            setChoice(value);
          }}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
