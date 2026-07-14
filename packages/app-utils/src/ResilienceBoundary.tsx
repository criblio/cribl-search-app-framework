import { Component, Fragment, type ErrorInfo, type ReactNode } from 'react';

export interface ResilienceFallbackProps {
  error: Error;
  retry: () => void;
}

export interface ResilienceBoundaryProps {
  children: ReactNode;
  title?: string;
  description?: string;
  fallback?: (props: ResilienceFallbackProps) => ReactNode;
  onError?: (error: Error, info: ErrorInfo) => void;
}

interface State {
  error: Error | null;
  resetKey: number;
}

/** Router-free render-failure containment for Cribl app roots and panels. */
export class ResilienceBoundary extends Component<ResilienceBoundaryProps, State> {
  state: State = { error: null, resetKey: 0 };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    this.props.onError?.(error, info);
  }

  private retry = (): void => {
    this.setState((state) => ({ error: null, resetKey: state.resetKey + 1 }));
  };

  render(): ReactNode {
    const { error } = this.state;
    if (error) {
      if (this.props.fallback) return this.props.fallback({ error, retry: this.retry });
      return (
        <section role="alert" style={{ padding: 'var(--cds-space-lg, 1.5rem)' }}>
          <h2>{this.props.title ?? 'This view is temporarily unavailable'}</h2>
          <p>
            {this.props.description ??
              'A rendering failure was contained here. Other app surfaces remain available.'}
          </p>
          <details>
            <summary>Technical detail</summary>
            <code>{error.message}</code>
          </details>
          <button type="button" onClick={this.retry}>Retry</button>
        </section>
      );
    }
    return <Fragment key={this.state.resetKey}>{this.props.children}</Fragment>;
  }
}
