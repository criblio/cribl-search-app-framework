/**
 * `<PartialFailureBanner>`: a failed panel is named, never silent.
 *
 * An empty table and "0 errors" from a query that FAILED read as healthy.
 * The banner exists to say otherwise, so its copy is part of the contract.
 * `renderToString` is enough: the banner is pure render.
 */
import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import { PARTIAL_FAILURE_TITLE, PartialFailureBanner } from '../PartialFailureBanner.js';

describe('PartialFailureBanner', () => {
  it('renders nothing when nothing failed', () => {
    expect(renderToString(<PartialFailureBanner failures={{}} onRetry={() => {}} />)).toBe('');
    expect(renderToString(<PartialFailureBanner failures={new Map()} />)).toBe('');
  });

  it('says empty is not healthy and names each failed panel', () => {
    const html = renderToString(
      <PartialFailureBanner
        failures={{ 'Request rate': '403 Forbidden', Dependencies: 'timeout' }}
        onRetry={() => {}}
      />,
    );
    expect(PARTIAL_FAILURE_TITLE).toContain('Empty values below are not evidence of health');
    expect(html).toContain('Empty values below are not evidence of health');
    expect(html).toContain('Request rate');
    expect(html).toContain('403 Forbidden');
    expect(html).toContain('Dependencies');
    expect(html).toContain('Retry unavailable data');
  });

  it('accepts a Map and omits Retry without a handler', () => {
    const html = renderToString(<PartialFailureBanner failures={new Map([['Logs', 'boom']])} />);
    expect(html).toContain('Logs');
    expect(html).toContain('boom');
    expect(html).not.toContain('Retry unavailable data');
  });
});
