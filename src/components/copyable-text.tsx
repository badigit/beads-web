"use client";

import { useState, useCallback } from "react";

import { Check } from "lucide-react";

import { cn } from "@/lib/utils";

interface CopyableTextProps {
  /** Text to display */
  children: React.ReactNode;
  /** Text to copy to clipboard (defaults to children text content) */
  copyText: string;
  className?: string;
}

/**
 * Inline text that copies to clipboard on click or Enter/Space.
 * Shows a checkmark + "Copied" for 2 seconds after copying.
 *
 * Events are stopped from propagating: these live inside clickable cards,
 * where bubbling would open the detail panel instead of copying.
 */
export function CopyableText({ children, copyText, className }: CopyableTextProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async (e: React.MouseEvent | React.KeyboardEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(copyText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback for insecure contexts
    }
  }, [copyText]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    handleCopy(e);
  }, [handleCopy]);

  if (copied) {
    return (
      <span className={cn("inline-flex items-center gap-0.5 text-success", className)}>
        <Check className="size-3" aria-hidden="true" />
        Copied
      </span>
    );
  }

  return (
    <span
      role="button"
      tabIndex={0}
      aria-label={`Copy ${copyText}`}
      onClick={handleCopy}
      onKeyDown={handleKeyDown}
      className={cn(
        "cursor-copy hover:text-t-secondary transition-colors",
        "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring rounded-sm",
        className
      )}
      title={`Click to copy: ${copyText}`}
    >
      {children}
    </span>
  );
}
