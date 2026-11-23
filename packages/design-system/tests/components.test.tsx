import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  Button,
  DataTable,
  Field,
  PageHeader,
  RiskChip,
  StateBoundary,
  StatusChip,
  TASK_STATES,
  ToastProvider,
  useToast,
  type StateBoundaryMessages,
} from '../src/index.js';

afterEach(cleanup);

const messages: StateBoundaryMessages = {
  loading: 'Loading…',
  empty: { title: 'Nothing here', description: 'No tasks yet.' },
  error: { title: 'Something went wrong', description: 'Try again.' },
  offline: { title: 'You are offline', description: 'Showing saved data.' },
  denied: { title: 'Not allowed', description: 'Ask your supervisor.' },
  retry: 'Try again',
};

describe('StatusChip / RiskChip', () => {
  it('always renders a text label and a decorative icon for every state', () => {
    for (const s of TASK_STATES) {
      const { container } = render(<StatusChip state={s} label={`label-${s}`} />);
      expect(screen.getByText(`label-${s}`)).toBeTruthy();
      expect(container.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
      cleanup();
    }
  });
  it('renders risk text', () => {
    render(<RiskChip level="critical" label="Critical" />);
    expect(screen.getByText('Critical')).toBeTruthy();
  });
});

describe('Button', () => {
  it('has the 44 px touch target and visible focus classes', () => {
    render(<Button>Save</Button>);
    const b = screen.getByRole('button', { name: 'Save' });
    expect(b.className).toContain('min-h-touch');
    expect(b.className).toContain('min-w-touch');
    expect(b.className).toContain('focus-visible:outline');
    expect(b.getAttribute('type')).toBe('button');
  });
  it('is disabled while busy', () => {
    render(<Button busy>Save</Button>);
    expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('Field', () => {
  it('links label, hint and error', () => {
    render(<Field label="Note" hint="Max 500" error="Required" maxLength={500} showCount value="abc" onChange={() => {}} />);
    const input = screen.getByLabelText('Note');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(input.getAttribute('aria-describedby')).toContain('hint');
    expect(screen.getByText('3 / 500')).toBeTruthy();
  });
});

describe('StateBoundary', () => {
  it('renders children only when ready', () => {
    render(
      <StateBoundary status="ready" messages={messages}>
        <p>content</p>
      </StateBoundary>,
    );
    expect(screen.getByText('content')).toBeTruthy();
  });
  it('shows loading as a status', () => {
    render(<StateBoundary status="loading" messages={messages} />);
    expect(screen.getByRole('status').textContent).toContain('Loading');
  });
  it('shows error with a retry next step', () => {
    const onRetry = vi.fn();
    render(<StateBoundary status="error" messages={messages} onRetry={onRetry} />);
    expect(screen.getByRole('alert').textContent).toContain('Something went wrong');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalled();
  });
  it('shows offline, denied and empty states with their next step', () => {
    const { rerender } = render(<StateBoundary status="offline" messages={messages} onRetry={() => {}} />);
    expect(screen.getByText('You are offline')).toBeTruthy();
    rerender(<StateBoundary status="denied" messages={messages} deniedAction={<a href="/">Home</a>} />);
    expect(screen.getByText('Not allowed')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Home' })).toBeTruthy();
    rerender(<StateBoundary status="empty" messages={messages} emptyAction={<a href="/">Home</a>} />);
    expect(screen.getByRole('heading', { name: 'Nothing here' })).toBeTruthy();
  });
});

describe('DataTable and PageHeader', () => {
  it('renders a captioned semantic table', () => {
    render(
      <DataTable
        caption="Tasks"
        columns={[{ key: 'n', header: 'Name', cell: (r: { id: string }) => r.id }]}
        rows={[{ id: 'a' }, { id: 'b' }]}
        getRowId={(r) => r.id}
      />,
    );
    expect(screen.getByRole('table', { name: 'Tasks' })).toBeTruthy();
    expect(screen.getAllByRole('row')).toHaveLength(3);
  });
  it('renders one h1', () => {
    render(<PageHeader title="Home" />);
    expect(screen.getByRole('heading', { level: 1, name: 'Home' })).toBeTruthy();
  });
});

describe('Toast', () => {
  function Trigger() {
    const t = useToast();
    return <Button onClick={() => t.show({ tone: 'success', title: 'Saved' })}>go</Button>;
  }
  it('announces a toast in a live region', () => {
    render(
      <ToastProvider dismissLabel="Dismiss">
        <Trigger />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'go' }));
    expect(screen.getByRole('status').textContent).toContain('Saved');
  });
});
