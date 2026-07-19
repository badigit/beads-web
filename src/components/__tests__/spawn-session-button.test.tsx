import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { SpawnSessionButton } from '../spawn-session-button';

const spawnMock = vi.fn();
const toastMock = vi.fn();

vi.mock('@/lib/api', () => ({
  session: {
    spawn: (...args: unknown[]) => spawnMock(...args),
  },
}));

vi.mock('@/hooks/use-toast', () => ({
  toast: (...args: unknown[]) => toastMock(...args),
  useToast: () => ({ toast: toastMock }),
}));

const okResponse = {
  success: true,
  session_id: 'sess-123',
  worktree_path: 'C:/repo/.worktrees/bd-x1',
  branch: 'bd-x1',
  worktree_already_existed: false,
  duration_ms: 35655,
};

/** Manual promise so the test controls when the spawn call settles. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const defaultProps = {
  beadId: 'bweb-en5.2',
  projectPath: 'C:/Users/Dee/GitHub/beads-web',
};

const buttonName = /start claude session/i;

beforeEach(() => {
  vi.clearAllMocks();
  spawnMock.mockResolvedValue(okResponse);
});

describe('SpawnSessionButton', () => {
  it('renders an accessible button for a filesystem project', () => {
    render(<SpawnSessionButton {...defaultProps} />);
    expect(screen.getByRole('button', { name: buttonName })).toBeEnabled();
  });

  it('renders nothing for a dolt:// project (path would fail server validation)', () => {
    const { container } = render(
      <SpawnSessionButton {...defaultProps} projectPath="dolt://beads-web" />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when the project path is unknown', () => {
    const { container } = render(
      <SpawnSessionButton {...defaultProps} projectPath={undefined} />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('posts the project path and bead id on click', async () => {
    render(<SpawnSessionButton {...defaultProps} />);
    fireEvent.click(screen.getByRole('button', { name: buttonName }));

    await waitFor(() =>
      expect(spawnMock).toHaveBeenCalledWith({
        project_path: defaultProps.projectPath,
        bead_id: defaultProps.beadId,
      })
    );
  });

  it('disables the button while the spawn is in flight', async () => {
    const d = deferred<typeof okResponse>();
    spawnMock.mockReturnValue(d.promise);

    render(<SpawnSessionButton {...defaultProps} />);
    const button = screen.getByRole('button', { name: buttonName });
    fireEvent.click(button);

    await waitFor(() => expect(button).toBeDisabled());

    d.resolve(okResponse);
    await waitFor(() => expect(button).toBeEnabled());
  });

  it('shows progress feedback while spawning (the call takes tens of seconds)', async () => {
    const d = deferred<typeof okResponse>();
    spawnMock.mockReturnValue(d.promise);

    render(<SpawnSessionButton {...defaultProps} />);
    fireEvent.click(screen.getByRole('button', { name: buttonName }));

    expect(await screen.findByRole('status')).toBeInTheDocument();

    d.resolve(okResponse);
    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
  });

  it('does not spawn twice on a double click', async () => {
    const d = deferred<typeof okResponse>();
    spawnMock.mockReturnValue(d.promise);

    render(<SpawnSessionButton {...defaultProps} />);
    const button = screen.getByRole('button', { name: buttonName });
    fireEvent.click(button);
    fireEvent.click(button);
    fireEvent.click(button);

    d.resolve(okResponse);
    await waitFor(() => expect(button).toBeEnabled());
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('shows the error next to the button instead of only toasting', async () => {
    spawnMock.mockRejectedValue(new Error('API error: 503 claude CLI not found'));

    render(<SpawnSessionButton {...defaultProps} />);
    fireEvent.click(screen.getByRole('button', { name: buttonName }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/claude CLI not found/i);
    expect(screen.getByRole('button', { name: buttonName })).toBeEnabled();
  });

  it('clears a previous error when the retry succeeds', async () => {
    spawnMock.mockRejectedValueOnce(new Error('API error: 504 timeout'));

    render(<SpawnSessionButton {...defaultProps} />);
    const button = screen.getByRole('button', { name: buttonName });
    fireEvent.click(button);
    await screen.findByRole('alert');

    fireEvent.click(button);
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  });

  it('toasts on success mentioning Claude Desktop', async () => {
    render(<SpawnSessionButton {...defaultProps} />);
    fireEvent.click(screen.getByRole('button', { name: buttonName }));

    await waitFor(() => expect(toastMock).toHaveBeenCalled());
    const arg = toastMock.mock.calls[0][0];
    expect(`${arg.title} ${arg.description}`).toMatch(/claude desktop/i);
    expect(arg.variant).not.toBe('destructive');
  });

  it('does not bubble the click to a clickable parent card', async () => {
    const onParentClick = vi.fn();
    render(
      // eslint-disable-next-line jsx-a11y/no-static-element-interactions, jsx-a11y/click-events-have-key-events
      <div onClick={onParentClick}>
        <SpawnSessionButton {...defaultProps} />
      </div>
    );
    const button = screen.getByRole('button', { name: buttonName });
    fireEvent.click(button);

    await waitFor(() => expect(button).toBeEnabled());
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(onParentClick).not.toHaveBeenCalled();
  });
});
