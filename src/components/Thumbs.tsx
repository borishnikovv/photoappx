import { useState } from 'react';
import { voteOf } from '../lib/taste';

/** 👍/👎 that teach Seam your taste. Tapping the same thumb again takes the vote back. */
export function Thumbs({ id, onVote, what }: { id: string; onVote: (v: 1 | -1) => void; what: string }) {
  const [, redraw] = useState(0);
  const v = voteOf(id);
  const vote = (x: 1 | -1) => {
    onVote(x);
    redraw((n) => n + 1);
  };
  return (
    <span className="thumbs">
      <button className="btn ghost icon sm" aria-pressed={v === 1} title={`More ${what} like this`} onClick={() => vote(1)}>
        👍
      </button>
      <button className="btn ghost icon sm" aria-pressed={v === -1} title={`Fewer ${what} like this`} onClick={() => vote(-1)}>
        👎
      </button>
    </span>
  );
}
