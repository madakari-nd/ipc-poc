import { Slot } from '@radix-ui/react-slot';
import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { cn } from '../cn.js';

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  /** Render the child element (e.g. a router Link) with button styling. */
  asChild?: boolean;
  /** Shows a busy state; the button stays focusable but is disabled. */
  busy?: boolean;
}

const variants: Record<ButtonVariant, string> = {
  primary: 'bg-action-primary text-action-primary-fg hover:bg-action-primary-hover',
  secondary:
    'bg-action-secondary text-action-secondary-fg hover:bg-action-secondary-hover border border-border',
  danger: 'bg-action-danger text-action-danger-fg hover:bg-action-danger-hover',
  ghost: 'bg-action-ghost text-action-ghost-fg hover:bg-action-ghost-hover',
};

export const buttonClass = (variant: ButtonVariant = 'primary', extra?: string): string =>
  cn(
    'inline-flex min-h-touch min-w-touch items-center justify-center gap-2 rounded-md px-4 py-2',
    'text-base font-semibold no-underline',
    'focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-offset-2 focus-visible:outline-focus',
    'disabled:cursor-not-allowed disabled:opacity-60',
    variants[variant],
    extra,
  );

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', asChild = false, busy = false, className, disabled, type, ...rest },
  ref,
) {
  const Comp = asChild ? Slot : 'button';
  return (
    <Comp
      ref={ref}
      className={buttonClass(variant, className)}
      disabled={asChild ? undefined : disabled || busy}
      aria-busy={busy || undefined}
      type={asChild ? undefined : (type ?? 'button')}
      {...rest}
    />
  );
});
