import { useState, type InputHTMLAttributes, type ReactNode } from "react";

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, "type"> & { label: ReactNode };

// Password input with a show/hide toggle. The button sits outside the <label> so it isn't read as part of the field's name.
export default function PasswordField({ label, ...input }: Props) {
  const [shown, setShown] = useState(false);
  return (
    <div className="password-field">
      <label>{label}<input {...input} type={shown ? "text" : "password"} /></label>
      <button type="button" className="reveal" aria-label="Show password" aria-pressed={shown} onClick={() => setShown(!shown)}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
          <circle cx="12" cy="12" r="3" />
          {shown && <path d="M3 3l18 18" />}
        </svg>
      </button>
    </div>
  );
}
