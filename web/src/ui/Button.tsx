import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { Icon, type IconName } from './Icon.tsx';
import { cx } from './cx.ts';

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md';
  icon?: IconName;
  block?: boolean;
  loading?: boolean;
  children?: ReactNode;
};

export function Button({
  variant = 'secondary',
  size = 'md',
  icon,
  block,
  loading,
  className,
  children,
  disabled,
  type = 'button',
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cx('btn', `btn-${variant}`, size === 'sm' && 'btn-sm', block && 'btn-block', className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <span className="spinner spinner-sm" aria-hidden="true" /> : icon ? <Icon name={icon} size={18} /> : null}
      {children != null && <span>{children}</span>}
    </button>
  );
}

type IconButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  icon: IconName;
  /** Obavezan tekst za čitače ekrana i tooltip. */
  label: string;
  size?: 'sm' | 'md';
  variant?: 'ghost' | 'secondary';
};

export function IconButton({ icon, label, size = 'md', variant = 'ghost', className, type = 'button', ...rest }: IconButtonProps) {
  return (
    <button
      type={type}
      className={cx('icon-btn', `icon-btn-${variant}`, size === 'sm' && 'icon-btn-sm', className)}
      aria-label={label}
      title={label}
      {...rest}
    >
      <Icon name={icon} size={size === 'sm' ? 18 : 20} />
    </button>
  );
}
