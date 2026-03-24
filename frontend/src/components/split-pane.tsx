"use client";

/**
 * Wrapper around react-resizable-panels for the split pane layout.
 * Re-exports with consistent styling.
 */

import {
  Panel,
  PanelGroup,
  PanelResizeHandle,
} from "react-resizable-panels";
import { cn } from "@/lib/utils";

export function ResizablePanelGroup({
  className,
  direction = "horizontal",
  children,
  ...props
}: {
  className?: string;
  direction?: "horizontal" | "vertical";
  children: React.ReactNode;
}) {
  return (
    <PanelGroup
      direction={direction}
      className={cn("h-full w-full", className)}
      {...props}
    >
      {children}
    </PanelGroup>
  );
}

export function ResizablePanel({
  className,
  children,
  ...props
}: {
  className?: string;
  children: React.ReactNode;
  defaultSize?: number;
  minSize?: number;
}) {
  return (
    <Panel className={cn("h-full", className)} {...props}>
      {children}
    </Panel>
  );
}

export function ResizableHandle({ className }: { className?: string }) {
  return (
    <PanelResizeHandle
      className={cn(
        "w-1.5 bg-border hover:bg-primary/50 transition-colors cursor-col-resize",
        className
      )}
    />
  );
}
