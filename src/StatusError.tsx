import { messageFor, type SidecarError } from "./errors";

/** A failed load, shown in place of the page with a Retry button. */
export default function StatusError({ error, retry }: { error: SidecarError; retry: () => void }) {
  return (
    <div className="status">
      <p>{messageFor(error)}</p>
      <button onClick={retry}>Retry</button>
    </div>
  );
}
