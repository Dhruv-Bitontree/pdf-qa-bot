"use client";

/**
 * Wrapper around react-resizable-panels for the split pane layout.
 * Re-exports with consistent styling.
 */

import {
  forwardRef,
  type ComponentProps,
  type ElementRef,
  type ReactNode,
} from "react";

import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { cn } from "@/lib/utils";

type PanelGroupProps = ComponentProps<typeof PanelGroup>;
type PanelProps = ComponentProps<typeof Panel>;

export const ResizablePanelGroup = forwardRef<
  ElementRef<typeof PanelGroup>,
  {
    className?: string;
    direction?: "horizontal" | "vertical";
    children: ReactNode;
  } & Omit<PanelGroupProps, "children" | "direction" | "className">
>(function ResizablePanelGroup(
  { className, direction = "horizontal", children, ...props },
  ref,
) {
  return (
    <PanelGroup
      ref={ref}
      direction={direction}
      className={cn("h-full w-full", className)}
      {...props}
    >
      {children}
    </PanelGroup>
  );
});

export const ResizablePanel = forwardRef<
  ElementRef<typeof Panel>,
  {
    className?: string;
    children: ReactNode;
  } & Omit<PanelProps, "children" | "className">
>(function ResizablePanel({ className, children, ...props }, ref) {
  return (
    <Panel ref={ref} className={cn("h-full", className)} {...props}>
      {children}
    </Panel>
  );
});

export function ResizableHandle({ className }: { className?: string }) {
  return (
    <PanelResizeHandle
      className={cn(
        "w-1.5 bg-border hover:bg-primary/50 transition-colors cursor-col-resize",
        className,
      )}
    />
  );
}
