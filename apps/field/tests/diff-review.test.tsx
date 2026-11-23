import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import './setup-i18n.js';
import { DiffReview } from '../src/features/conflict/DiffReview.js';
import { diffChangeSet, reapplyBody } from '../src/features/conflict/diff.js';

afterEach(cleanup);

describe('diff helpers', () => {
  it('compares each changed field with the server version', () => {
    expect(diffChangeSet({ a: 1, b: 'x' }, { a: 1, b: 'y', c: 3 })).toEqual([
      { field: 'a', mine: 1, server: 1, differs: false },
      { field: 'b', mine: 'x', server: 'y', differs: true },
    ]);
    expect(reapplyBody({ a: 1, b: 2 }, new Set(['b']))).toEqual({ b: 2 });
  });
});

describe('<DiffReview> (409 VERSION_CONFLICT)', () => {
  const mine = { title: 'Wash hands at entry', ownerUserId: 'u1' };
  const current = { title: 'Wash hands at every entry', ownerUserId: 'u1', v: 5 };

  it('shows the user change against the server version and re-applies on the current version', () => {
    const onReapply = vi.fn();
    render(<DiffReview mine={mine} current={current} currentVersion={5} onReapply={onReapply} onKeepServer={() => {}} />);
    expect(screen.getByRole('table', { name: /your change compared/i })).toBeTruthy();
    expect(screen.getByText('Wash hands at entry')).toBeTruthy();
    expect(screen.getByText('Wash hands at every entry')).toBeTruthy();
    expect(screen.getByText('Same')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain('1 field is different');
    fireEvent.click(screen.getByRole('button', { name: 'Send my change again' }));
    expect(onReapply).toHaveBeenCalledWith(mine, 5);
  });

  it('drops fields the user gives up to the server, and can keep the server version', () => {
    const onReapply = vi.fn();
    const onKeepServer = vi.fn();
    render(<DiffReview mine={mine} current={current} currentVersion={5} onReapply={onReapply} onKeepServer={onKeepServer} />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Keep mine' }));
    fireEvent.click(screen.getByRole('button', { name: 'Send my change again' }));
    expect(onReapply).toHaveBeenCalledWith({ ownerUserId: 'u1' }, 5);
    fireEvent.click(screen.getByRole('button', { name: 'Keep the latest version' }));
    expect(onKeepServer).toHaveBeenCalled();
  });
});
