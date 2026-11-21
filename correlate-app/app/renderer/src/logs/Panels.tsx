/**
 * cttc's `#panels` (REQ-000029-sJpO9KMY Requirement 2): one log panel per
 * container the charts show, side by side, in the legend's order; and the
 * panels' remembered choices (order, lanes open), kept by the main process.
 * Export goes to the main process, which asks for the file first
 * (Requirement 4).
 */
import { useCallback, useEffect, useState } from "react";
import type { ChartsShown } from "../charts/ChartBlock.js";
import type { ShellBridge } from "../shell/bridge.js";
import type { Order } from "./api.js";
import { LogPanel } from "./LogPanel.js";

/** The panels' choices: newest first and lanes folded until changed (cttc's). */
export function useLogPrefs(bridge: ShellBridge) {
  const [order, setOrderState] = useState<Order>("newest");
  const [lanesOpen, setLanesState] = useState(false);
  useEffect(() => {
    let live = true;
    void bridge.logs?.prefs().then((p) => {
      if (!live) return;
      setOrderState(p.order);
      setLanesState(p.lanesOpen);
    });
    return () => {
      live = false;
    };
  }, [bridge]);
  const setOrder = useCallback(
    (next: Order) => {
      setOrderState(next);
      void bridge.logs?.setPrefs({ order: next });
    },
    [bridge],
  );
  const setLanesOpen = useCallback(
    (open: boolean) => {
      setLanesState(open);
      void bridge.logs?.setPrefs({ lanesOpen: open });
    },
    [bridge],
  );
  return { order, setOrder, lanesOpen, setLanesOpen };
}

/** The panels' props. */
export interface PanelsProps {
  bridge: ShellBridge;
  shown: ChartsShown;
  order: Order;
  onOrder: (order: Order) => void;
}

/** The log panels. */
export function Panels({ bridge, shown, order, onOrder }: PanelsProps) {
  const exportLog = async (name: string) => {
    if (!bridge.logs) return;
    const r = await bridge.logs.exportLog({
      source: `${shown.stream.id}/${name}`,
      name,
      from: new Date(shown.view.t0).toISOString(),
      to: new Date(shown.view.t1).toISOString(),
      order,
    });
    if (r.ok) void bridge.status.add(`Log exported: ${r.path} (${r.rows} entries)`);
    else if (!r.cancelled) void bridge.status.add(`Could not export log: ${r.message}`);
  };
  return (
    <section id="panels" aria-label="Logs">
      {shown.containers.map((name) => (
        <LogPanel
          key={name}
          request={bridge.sump.request}
          source={`${shown.stream.id}/${name}`}
          name={name}
          view={shown.view}
          order={order}
          onOrder={onOrder}
          onExport={() => void exportLog(name)}
          onHide={() => shown.hide(name)}
        />
      ))}
    </section>
  );
}
