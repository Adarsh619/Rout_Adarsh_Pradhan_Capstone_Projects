import { useState } from "react";

/**
 * Left side of the issue modal's footer. The reporter or an admin gets a Delete button; any other member
 * is told who can delete the issue and can ask the workspace admins to do it (bell notification + email).
 *
 * `reporterName` is null when the reporter has left the workspace. `onRequest` resolves to the API's
 * response: `{notified}` for a new request, `{already_requested: true}` for a repeat.
 */
export default function DeleteIssueControls({ canDelete, issueKey, reporterName, onDelete, onRequest }) {
  const [state, setState] = useState("idle"); // idle | sending | sent | error

  if (canDelete) {
    return <button type="button" className="danger" onClick={onDelete}>Delete</button>;
  }

  const ask = async () => {
    setState("sending");
    try {
      await onRequest();
      setState("sent");
    } catch {
      setState("error");
    }
  };

  return (
    <div className="notice" role="note">
      <span aria-hidden="true">🔒</span>
      <span>
        {reporterName
          ? <>Only <strong>{reporterName}</strong> (who created {issueKey}) or a workspace admin can delete it.</>
          : <>Only a workspace admin can delete {issueKey}.</>}
      </span>
      {state === "sent" ? (
        <span className="notice-done">✓ Request sent to admins</span>
      ) : (
        <button type="button" className="notice-action" onClick={ask} disabled={state === "sending"}>
          {state === "sending" ? "Sending…" : state === "error" ? "Couldn't send — try again" : "Ask an admin to delete"}
        </button>
      )}
    </div>
  );
}
