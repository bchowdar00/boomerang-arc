// The desk's offer of a ten-minute campaign, shared by the blank cheque and the landing page's
// closing button: one press asks the keeper, says what it answered, and goes to the new campaign.
import { useState } from "react";

import type { Ctx } from "../app/context.ts";
import { hrefFor } from "../app/route.ts";

export type DeskState = { busy: boolean; line: string | null; ok: boolean; open(): void };

export function useDesk(ctx: Ctx): DeskState {
  const [state, setState] = useState<{ busy: boolean; line: string | null; ok: boolean }>({ busy: false, line: null, ok: false });
  const open = () => {
    if (state.busy) return;
    setState({ busy: true, line: null, ok: false });
    void ctx.askForCampaign().then((answer) => {
      setState({ busy: false, line: answer.line, ok: answer.ok });
      ctx.refresh();
      if (answer.ok && answer.id !== null) window.location.hash = hrefFor({ page: "campaign", id: answer.id });
    });
  };
  return { ...state, open };
}
