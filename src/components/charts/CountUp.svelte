<script lang="ts">
  import { interpolateNumber } from 'd3-interpolate';

  interface Props {
    metrics: {
      hospitalCount: number;
      totalSubsidy: number;
      maxEnergySaving: number;
      eventCount: number;
    };
  }

  let { metrics }: Props = $props();
  let container: HTMLElement | undefined = $state(undefined);
  let animated = $state(false);
  let progress = $state(0);

  const items = $derived([
    { value: metrics.hospitalCount, suffix: '+', label: '合作醫院', unit: '家' },
    {
      value: metrics.totalSubsidy,
      suffix: '',
      label: '協助申請補助',
      unit: '萬元',
      format: (v: number) => Math.round(v / 10000).toLocaleString(),
    },
    { value: metrics.maxEnergySaving, suffix: '%', label: '最高節能', unit: '' },
    { value: metrics.eventCount, suffix: '+', label: '場活動', unit: '' },
  ]);

  $effect(() => {
    if (!container) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && !animated) {
          animated = true;
          const start = performance.now();
          const duration = 2000;
          function tick(now: number) {
            progress = Math.min((now - start) / duration, 1);
            if (progress < 1) requestAnimationFrame(tick);
          }
          requestAnimationFrame(tick);
        }
      },
      { threshold: 0.3 },
    );
    observer.observe(container);
    return () => observer.disconnect();
  });

  function displayValue(item: (typeof items)[0]): string {
    const interpolated = interpolateNumber(0, item.value)(progress);
    if (item.format) return item.format(interpolated);
    return Math.round(interpolated).toLocaleString();
  }
</script>

<div class="countup" bind:this={container}>
  {#each items as item}
    <div class="countup__item">
      <span class="countup__number">
        {displayValue(item)}{item.suffix}
      </span>
      <span class="countup__unit">{item.unit}</span>
      <span class="countup__label">{item.label}</span>
    </div>
  {/each}
</div>

<noscript>
  <div class="countup">
    {#each items as item}
      <div class="countup__item">
        <span class="countup__number">
          {item.format ? item.format(item.value) : item.value}{item.suffix}
        </span>
        <span class="countup__unit">{item.unit}</span>
        <span class="countup__label">{item.label}</span>
      </div>
    {/each}
  </div>
</noscript>

<style>
  .countup {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: var(--space-lg);
    padding-block: var(--space-2xl);
    text-align: center;
  }

  .countup__item {
    display: flex;
    flex-direction: column;
    gap: var(--space-xs);
  }

  .countup__number {
    font-size: var(--text-3xl);
    font-weight: 700;
    color: var(--color-primary);
  }

  .countup__unit {
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
  }

  .countup__label {
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
  }

  @media (max-width: 640px) {
    .countup {
      grid-template-columns: repeat(2, 1fr);
    }
  }
</style>
