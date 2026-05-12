<script lang="ts">
  interface Hospital {
    name: string;
    location: string;
    system: string;
    slug: string;
    energySaving: number;
    subsidy: number;
  }

  interface Props {
    hospitals: Hospital[];
  }

  let { hospitals }: Props = $props();

  // Approximate city coordinates [lng, lat]
  const cityCoords: Record<string, [number, number]> = {
    '台北市': [121.56, 25.03],
    '新北市': [121.47, 25.01],
    '基隆市': [121.74, 25.13],
    '桃園市': [121.30, 24.99],
    '新竹市': [120.97, 24.80],
    '新竹縣': [121.00, 24.84],
    '苗栗縣': [120.82, 24.56],
    '台中市': [120.68, 24.15],
    '彰化縣': [120.54, 24.08],
    '南投縣': [120.69, 23.91],
    '雲林縣': [120.53, 23.71],
    '嘉義市': [120.45, 23.48],
    '嘉義縣': [120.43, 23.45],
    '台南市': [120.20, 23.00],
    '高雄市': [120.30, 22.63],
    '屏東縣': [120.49, 22.67],
    '宜蘭縣': [121.75, 24.75],
    '花蓮市': [121.60, 23.99],
    '花蓮縣': [121.60, 23.99],
    '台東市': [121.14, 22.75],
    '台東縣': [121.14, 22.75],
    '澎湖縣': [119.58, 23.57],
    '金門縣': [118.32, 24.43],
    '連江縣': [119.95, 26.16],
    '左營區': [120.29, 22.69],
    '岡山區': [120.30, 22.79],
    '北投區': [121.50, 25.13],
  };

  // Simple Mercator-like projection for Taiwan area
  // Map bounds: lng 118-122.5, lat 21.5-26.5
  const svgWidth = 300;
  const svgHeight = 440;
  const padding = 30;

  function projectLng(lng: number): number {
    return padding + ((lng - 118) / (122.5 - 118)) * (svgWidth - 2 * padding);
  }

  function projectLat(lat: number): number {
    // Invert Y axis for SVG
    return padding + ((26.5 - lat) / (26.5 - 21.5)) * (svgHeight - 2 * padding);
  }

  const positioned = $derived(
    hospitals
      .map((h) => {
        const coords = cityCoords[h.location];
        if (!coords) return null;
        return {
          ...h,
          x: projectLng(coords[0]),
          y: projectLat(coords[1]),
        };
      })
      .filter((h): h is NonNullable<typeof h> => h !== null),
  );

  let tooltip = $state<{ x: number; y: number; hospital: Hospital } | null>(null);

  function dotColor(system: string): string {
    if (system === 'military') return 'var(--color-chart-4)';
    if (system === 'veterans') return 'var(--color-chart-2)';
    return 'var(--color-chart-1)';
  }

  function showTooltip(event: MouseEvent, hospital: Hospital) {
    const target = event.currentTarget as SVGElement;
    const svg = target.closest('svg');
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    tooltip = {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top - 10,
      hospital,
    };
  }

  function hideTooltip() {
    tooltip = null;
  }

  // Simplified Taiwan outline path (approximate)
  const taiwanOutline =
    'M 185 40 C 195 55 200 70 205 90 C 210 110 208 130 205 150 ' +
    'C 202 170 200 190 195 210 C 190 230 185 250 178 270 ' +
    'C 172 290 165 310 158 325 C 150 340 142 350 135 355 ' +
    'C 128 360 120 358 115 350 C 110 342 108 330 110 315 ' +
    'C 112 300 118 285 125 270 C 132 255 138 240 142 220 ' +
    'C 146 200 148 180 152 160 C 156 140 160 120 165 100 ' +
    'C 170 80 175 60 180 45 Z';
</script>

<div class="results-map">
  <div class="results-map__chart" role="img" aria-label="台灣醫療院所合作成果地圖">
    <svg viewBox="0 0 {svgWidth} {svgHeight}" xmlns="http://www.w3.org/2000/svg">
      <!-- Taiwan outline -->
      <path d={taiwanOutline} fill="var(--color-primary-pale)" stroke="var(--color-border)" stroke-width="1.5" />

      <!-- Hospital dots -->
      {#each positioned as h}
        <circle
          cx={h.x}
          cy={h.y}
          r="8"
          fill={dotColor(h.system)}
          opacity="0.85"
          stroke="var(--color-paper)"
          stroke-width="2"
          style="cursor: pointer;"
          role="button"
          tabindex="0"
          aria-label="{h.name}"
          onmouseenter={(e: MouseEvent) => showTooltip(e, h)}
          onmouseleave={hideTooltip}
          onclick={() => { window.location.href = `/results/${h.slug}/`; }}
          onkeydown={(e: KeyboardEvent) => { if (e.key === 'Enter') window.location.href = `/results/${h.slug}/`; }}
        />
      {/each}
    </svg>

    <!-- Tooltip -->
    {#if tooltip}
      <div
        class="results-map__tooltip"
        style="left: {tooltip.x}px; top: {tooltip.y}px;"
      >
        <strong>{tooltip.hospital.name}</strong>
        <span>{tooltip.hospital.location}</span>
        {#if tooltip.hospital.energySaving > 0}
          <span>節能: {tooltip.hospital.energySaving}%</span>
        {/if}
        {#if tooltip.hospital.subsidy > 0}
          <span>補助: {(tooltip.hospital.subsidy / 10000).toLocaleString()} 萬元</span>
        {/if}
      </div>
    {/if}
  </div>

  <!-- Legend -->
  <div class="results-map__legend">
    <div class="results-map__legend-item">
      <span class="results-map__legend-dot" style="background-color: var(--color-chart-4);"></span>
      <span>國軍醫院</span>
    </div>
    <div class="results-map__legend-item">
      <span class="results-map__legend-dot" style="background-color: var(--color-chart-2);"></span>
      <span>榮民醫院</span>
    </div>
    <div class="results-map__legend-item">
      <span class="results-map__legend-dot" style="background-color: var(--color-chart-1);"></span>
      <span>其他醫院</span>
    </div>
  </div>
</div>

<noscript>
  <table>
    <caption>合作醫院一覽</caption>
    <thead>
      <tr><th>醫院名稱</th><th>所在地</th><th>體系</th><th>節能(%)</th></tr>
    </thead>
    <tbody>
      {#each hospitals as h}
        <tr>
          <td>{h.name}</td>
          <td>{h.location}</td>
          <td>{h.system === 'military' ? '國軍' : h.system === 'veterans' ? '榮民' : '其他'}</td>
          <td>{h.energySaving}</td>
        </tr>
      {/each}
    </tbody>
  </table>
</noscript>

<style>
  .results-map {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-lg);
    padding-block: var(--space-xl);
  }

  .results-map__chart {
    position: relative;
    width: 100%;
    max-width: 300px;
  }

  .results-map__chart svg {
    width: 100%;
    height: auto;
    display: block;
  }

  .results-map__tooltip {
    position: absolute;
    transform: translate(-50%, -100%);
    background-color: var(--color-text);
    color: var(--color-paper);
    padding: var(--space-sm) var(--space-md);
    border-radius: var(--radius-sm);
    font-size: var(--text-xs);
    white-space: nowrap;
    pointer-events: none;
    display: flex;
    flex-direction: column;
    gap: 2px;
    z-index: 10;
  }

  .results-map__tooltip::after {
    content: '';
    position: absolute;
    top: 100%;
    left: 50%;
    transform: translateX(-50%);
    border: 5px solid transparent;
    border-top-color: var(--color-text);
  }

  .results-map__legend {
    display: flex;
    gap: var(--space-lg);
    flex-wrap: wrap;
    justify-content: center;
  }

  .results-map__legend-item {
    display: flex;
    align-items: center;
    gap: var(--space-xs);
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
  }

  .results-map__legend-dot {
    display: inline-block;
    width: 12px;
    height: 12px;
    border-radius: 50%;
    flex-shrink: 0;
  }
</style>
