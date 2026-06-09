export type GateDesiredState = "Enabled" | "Draining" | "Disabled" | "Maintenance";

export interface GateLifecycleCondition {
  type: "AgentConnected" | "Ready" | "Schedulable";
  status: "True" | "False";
  reason: string;
  message: string;
}

export function resolveGateAgentConnectedCondition(connected: boolean): GateLifecycleCondition {
  return {
    type: "AgentConnected",
    status: connected ? "True" : "False",
    reason: connected ? "HeartbeatFresh" : "HeartbeatStale",
    message: connected ? "Gate agent heartbeat is fresh" : "Gate agent heartbeat is stale"
  };
}

export function isGateSchedulable(ready: boolean, doubleZeroReady: boolean, desiredState: string): boolean {
  return ready && doubleZeroReady && desiredState === "Enabled";
}

export function resolveGateHeartbeatConditions(input: {
  ready: boolean;
  reason: string;
  message: string;
  doubleZeroReady: boolean;
  doubleZeroReason: string;
  doubleZeroMessage: string;
  desiredState: GateDesiredState;
}): GateLifecycleCondition[] {
  const schedulable = isGateSchedulable(input.ready, input.doubleZeroReady, input.desiredState);
  return [
    {
      type: "Ready",
      status: input.ready ? "True" : "False",
      reason: input.reason,
      message: input.message
    },
    {
      type: "Schedulable",
      status: schedulable ? "True" : "False",
      reason: schedulable ? "Enabled" : schedulableBlockedReason(input),
      message: schedulable
        ? "Gate is eligible for new sessions"
        : schedulableBlockedMessage(input)
    }
  ];
}

export function resolveGateStaleConditions(): GateLifecycleCondition[] {
  return [
    resolveGateAgentConnectedCondition(false),
    ...resolveGateHeartbeatConditions({
      ready: false,
      reason: "HeartbeatStale",
      message: "Gate agent heartbeat is stale",
      doubleZeroReady: false,
      doubleZeroReason: "HeartbeatStale",
      doubleZeroMessage: "Gate agent heartbeat is stale",
      desiredState: "Enabled"
    })
  ];
}

function schedulableBlockedReason(input: {
  ready: boolean;
  reason: string;
  doubleZeroReady: boolean;
  doubleZeroReason: string;
  desiredState: GateDesiredState;
}): string {
  if (!input.ready) {
    return input.reason;
  }
  if (!input.doubleZeroReady) {
    return input.doubleZeroReason;
  }
  return `DesiredState${input.desiredState}`;
}

function schedulableBlockedMessage(input: {
  ready: boolean;
  message: string;
  doubleZeroReady: boolean;
  doubleZeroMessage: string;
  desiredState: GateDesiredState;
}): string {
  if (!input.ready) {
    return `Gate is not eligible for new sessions: ${input.message}`;
  }
  if (!input.doubleZeroReady) {
    return `Gate is not eligible for new sessions: ${input.doubleZeroMessage}`;
  }
  return `Gate desired state is ${input.desiredState}, so it is not eligible for new sessions`;
}
