import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";

/**
 * Blocking loading state for the Stack Trace analysis request.
 * Rendered outside #root so the application can be marked inert while this
 * dialog keeps focus. No artificial percentage or invented backend stages.
 */
export function StackTraceLoadingOverlay() {
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const appRoot = document.getElementById("root");
    const previousInert = appRoot?.inert ?? false;
    const previousOverflow = document.body.style.overflow;
    const previousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;

    if (appRoot) appRoot.inert = true;
    document.body.style.overflow = "hidden";
    dialogRef.current?.focus();

    return () => {
      if (appRoot) appRoot.inert = previousInert;
      document.body.style.overflow = previousOverflow;
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, []);

  return createPortal(
    <div className="stack-ux-loading-backdrop">
      <div
        ref={dialogRef}
        className="stack-ux-loading-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="stack-ux-loading-title"
        aria-describedby="stack-ux-loading-description stack-ux-loading-time"
        tabIndex={-1}
      >
        <div className="stack-ux-loading-illustration" aria-hidden="true">
          <span className="stack-ux-loading-ring stack-ux-loading-ring-outer" />
          <span className="stack-ux-loading-ring stack-ux-loading-ring-inner" />
          <svg className="stack-ux-loading-art" viewBox="0 0 160 128" fill="none" xmlns="http://www.w3.org/2000/svg">
            <rect x="38" y="19" width="88" height="69" rx="10" fill="#E8F0FF" stroke="#6B9EFF" strokeWidth="5" />
            <rect x="29" y="29" width="88" height="69" rx="9" fill="#FFFFFF" stroke="#3978F0" strokeWidth="5" />
            <path d="M16 104H115L124 114H9L16 104Z" fill="#A8C6FC" stroke="#6E9EF2" strokeWidth="3" strokeLinejoin="round" />
            <path d="M59 48L48 58L59 68M88 48L99 58L88 68M81 44L67 73" stroke="#2166DC" strokeWidth="6" strokeLinecap="round" strokeLinejoin="round" />
            <circle className="stack-ux-loading-lens" cx="114" cy="85" r="21" fill="#F3F8FF" fillOpacity="0.94" stroke="#1765E9" strokeWidth="6" />
            <path d="M130 102L146 118" stroke="#1765E9" strokeWidth="8" strokeLinecap="round" />
          </svg>
        </div>

        <h2 id="stack-ux-loading-title">Analysis in Progress</h2>
        <p id="stack-ux-loading-description" className="stack-ux-loading-description">
          Checking code, resolving fields, and verifying permissions...
        </p>
        <div className="stack-ux-loading-dots" aria-hidden="true">
          <span /><span /><span />
        </div>
        <p id="stack-ux-loading-time" className="stack-ux-loading-time">
          This may take 20–30 seconds or longer for complex traces.
        </p>
      </div>
    </div>,
    document.body,
  );
}
