<script lang="ts">
  import { scaleBand, scaleLinear } from 'd3-scale';

  interface Hospital {
    name: string;
    location: string;
    system: string;
    slug: string;
    energySaving: number;
    subsidy: number;
    services: string[];
  }

  interface Props {
    hospitals: Hospital[];
  }

  let { hospitals }: Props = $props();

  // ── Bar chart: subsidy amounts per hospital ──
  const barWidth = 600;
  const barMargin = { top: 20, right: 30, bottom: 20, left: 140 };
  const barInnerWidth = barWidth - barMargin.left - barMargin.right;
  const barHeight = $derived(hospitals.length * 48 + barMargin.top + barMargin.bottom);

  const yScale = $derived(
    scaleBand<string>()
      .domain(hospitals.map((h) => h.name))
      .range([barMargin.top, barHeight - barMargin.bottom])
      .padding(0.3),
  );

  const maxSubsidy = $derived(Math.max(...hospitals.map((h) => h.subsidy), 1));

  const xScale = $derived(
    scaleLinear()
      .domain([0, maxSubsidy])
      .range([0, barInnerWidth])
      .nice(),
  );

  function barColor(system: string): string {
    if (system === 'military') return 'var(--color-chart-4)';
    if (system === 'veterans') return 'var(--color-chart-2)';
    return 'var(--color-chart-1)';
  }

  function formatAmount(value: number): string {
    if (value === 0) return '--';
    return (value / 10000).toLocaleString() + ' 萬';
  }

  // ── Heatmap: services x hospitals ──
  const serviceLabels: Record<string, string> = {
    'carbon-audit': '碳盤查',
    'ems': '能管系統',
    'esg-report': 'ESG 報告',
    'awards': '獎項輔導',
    'subsidies': '補助申請',
    'health-taiwan': '健康台灣',
  };

  const serviceKeys = Object.keys(serviceLabels);
  const heatCellSize = 44;
  const heatLabelWidth = 140;
  const heatHeaderHeight = 60;
  const heatmapWidth = $derived(heatLabelWidth + serviceKeys.length * heatCellSize + 20);
  const heatmapHeight = $derived(heatHeaderHeight + hospitals.length * heatCellSize + 10);
</script>

<div class="metrics-dashboard">
  <!-- Subsidy bar chart -->
  <div class="metrics-dashboard__section">
    <h3 class="metrics-dashboard__title">補助金額</h3>
    <div class="metrics-dashboard__chart">
      <svg viewBox="0 0 {barWidth} {barHeight}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="各醫院補助金額柱狀圖">
        {#each hospitals as h}
          {@const y = yScale(h.name) ?? 0}
          {@const bh = yScale.bandwidth()}
          {@const bw = xScale(h.subsidy)}

          <!-- Hospital name label -->
          <text
            x={barMargin.left - 8}
            y={y + bh / 2}
            text-anchor="end"
            dominant-baseline="central"
            font-size="12"
            fill="var(--color-text)"
          >
            {h.name}
          </text>

          <!-- Bar -->
          <rect
            x={barMargin.left}
            y={y}
            width={bw}
            height={bh}
            rx="4"
            fill={barColor(h.system)}
            opacity="0.85"
          />

          <!-- Value label -->
          <text
            x={barMargin.left + bw + 6}
            y={y + bh / 2}
            dominant-baseline="central"
            font-size="11"
            fill="var(--color-text-secondary)"
          >
            {formatAmount(h.subsidy)}
          </text>
        {/each}
      </svg>
    </div>
  </div>

  <!-- Service heatmap -->
  <div class="metrics-dashboard__section">
    <h3 class="metrics-dashboard__title">服務矩陣</h3>
    <div class="metrics-dashboard__chart">
      <svg viewBox="0 0 {heatmapWidth} {heatmapHeight}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="醫院服務矩陣熱力圖">
        <!-- Column headers (services) -->
        {#each serviceKeys as svc, si}
          <text
            x={heatLabelWidth + si * heatCellSize + heatCellSize / 2}
            y={heatHeaderHeight - 8}
            text-anchor="middle"
            font-size="11"
            fill="var(--color-text-secondary)"
            transform="rotate(-30, {heatLabelWidth + si * heatCellSize + heatCellSize / 2}, {heatHeaderHeight - 8})"
          >
            {serviceLabels[svc]}
          </text>
        {/each}

        <!-- Rows (hospitals) -->
        {#each hospitals as h, hi}
          <!-- Row label -->
          <text
            x={heatLabelWidth - 8}
            y={heatHeaderHeight + hi * heatCellSize + heatCellSize / 2}
            text-anchor="end"
            dominant-baseline="central"
            font-size="12"
            fill="var(--color-text)"
          >
            {h.name}
          </text>

          <!-- Cells -->
          {#each serviceKeys as svc, si}
            {@const hasService = h.services.includes(svc)}
            <rect
              x={heatLabelWidth + si * heatCellSize + 2}
              y={heatHeaderHeight + hi * heatCellSize + 2}
              width={heatCellSize - 4}
              height={heatCellSize - 4}
              rx="4"
              fill={hasService ? 'var(--color-primary)' : 'var(--color-surface)'}
              opacity={hasService ? 0.75 : 1}
              stroke="var(--color-border)"
              stroke-width="0.5"
            />
            {#if hasService}
              <text
                x={heatLabelWidth + si * heatCellSize + heatCellSize / 2}
                y={heatHeaderHeight + hi * heatCellSize + heatCellSize / 2}
                text-anchor="middle"
                dominant-baseline="central"
                font-size="16"
                fill="var(--color-paper)"
              >&#10003;</text>
            {/if}
          {/each}
        {/each}
      </svg>
    </div>
  </div>
</div>

<noscript>
  <table>
    <caption>醫院補助金額與服務一覽</caption>
    <thead>
      <tr><th>醫院名稱</th><th>體系</th><th>節能(%)</th><th>補助金額</th></tr>
    </thead>
    <tbody>
      {#each hospitals as h}
        <tr>
          <td>{h.name}</td>
          <td>{h.system === 'military' ? '國軍' : h.system === 'veterans' ? '榮民' : '其他'}</td>
          <td>{h.energySaving}</td>
          <td>{formatAmount(h.subsidy)}</td>
        </tr>
      {/each}
    </tbody>
  </table>
</noscript>

<style>
  .metrics-dashboard {
    display: flex;
    flex-direction: column;
    gap: var(--space-2xl);
  }

  .metrics-dashboard__section {
    display: flex;
    flex-direction: column;
    gap: var(--space-md);
  }

  .metrics-dashboard__title {
    font-size: var(--text-lg);
    font-family: var(--font-heading);
    font-weight: 700;
    color: var(--color-text);
  }

  .metrics-dashboard__chart {
    width: 100%;
    overflow-x: auto;
  }

  .metrics-dashboard__chart svg {
    width: 100%;
    max-width: 600px;
    height: auto;
    display: block;
  }

  @media (max-width: 640px) {
    .metrics-dashboard__chart svg {
      min-width: 480px;
    }
  }
</style>
