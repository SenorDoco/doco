interface NodeDialogLinkClickEvent {
  defaultPrevented: boolean;
  button: number;
  metaKey: boolean;
  altKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  currentTarget?: {
    target?: string | null;
  };
  preventDefault(): void;
}

function shouldHandleNodeDialogClick(event: NodeDialogLinkClickEvent): boolean {
  if (event.defaultPrevented) return false;
  if (event.button !== 0) return false;
  if (event.metaKey || event.altKey || event.ctrlKey || event.shiftKey) return false;
  const target = event.currentTarget?.target;
  return !target || target === "_self";
}

export function handleNodeDialogLinkClick(
  event: NodeDialogLinkClickEvent,
  openDialog: () => void,
): boolean {
  if (!shouldHandleNodeDialogClick(event)) return false;
  event.preventDefault();
  openDialog();
  return true;
}
