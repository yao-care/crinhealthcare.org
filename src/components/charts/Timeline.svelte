<script lang="ts">
  import { scaleTime } from 'd3-scale';

  interface TimelineEvent {
    date: string;
    title: string;
    organization: string;
    attendees: number;
    type: string;
  }

  interface Props {
    events: TimelineEvent[];
  }

  let { events }: Props = $props();

  const sorted = $derived(
    [...events].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()),
  );

  const svgHeight = $derived(Math.max(sorted.length * 140, 200));
  const svgWidth = 600;
  const centerX = svgWidth / 2;
  const nodeRadius = 8;

  // Vertical position for each event
  const positions = $derived(
    sorted.map((_, i) => {
      const topPad = 40;
      const spacing = 130;
      return topPad + i * spacing;
    }),
  );

  function formatDate(dateStr: string): string {
    const d = new Date(dateStr);
    return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
  }

  function typeColor(type: string): string {
    if (type === 'certification') return 'var(--color-accent)';
    if (type === 'seminar') return 'var(--color-chart-4)';
    return 'var(--color-primary)';
  }
</script>

<div class="timeline" role="list" aria-label="活動時間軸">
  <svg viewBox="0 0 {svgWidth} {svgHeight}" xmlns="http://www.w3.org/2000/svg">
    <!-- Vertical center line -->
    <line
      x1={centerX}
      y1="20"
      x2={centerX}
      y2={svgHeight - 20}
      stroke="var(--color-border)"
      stroke-width="2"
      stroke-dasharray="6,4"
    />

    {#each sorted as event, i}
      {@const y = positions[i]}
      {@const isLeft = i % 2 === 0}
      {@const cardX = isLeft ? centerX - 240 : centerX + 40}

      <!-- Connector line -->
      <line
        x1={isLeft ? centerX - 30 : centerX + 30}
        y1={y}
        x2={centerX}
        y2={y}
        stroke="var(--color-border)"
        stroke-width="1.5"
      />

      <!-- Node circle -->
      <circle
        cx={centerX}
        cy={y}
        r={nodeRadius}
        fill={typeColor(event.type)}
        stroke="var(--color-paper)"
        stroke-width="3"
      />

      <!-- Card background -->
      <rect
        x={cardX}
        y={y - 35}
        width="200"
        height="72"
        rx="8"
        fill="var(--color-paper)"
        stroke="var(--color-border)"
        stroke-width="1"
      />

      <!-- Date badge -->
      <rect
        x={cardX + 8}
        y={y - 28}
        width="90"
        height="20"
        rx="4"
        fill={typeColor(event.type)}
        opacity="0.15"
      />
      <text
        x={cardX + 53}
        y={y - 14}
        text-anchor="middle"
        font-size="11"
        font-weight="600"
        fill={typeColor(event.type)}
      >
        {formatDate(event.date)}
      </text>

      <!-- Title -->
      <text
        x={cardX + 10}
        y={y + 6}
        font-size="13"
        font-weight="700"
        fill="var(--color-text)"
      >
        {event.title.length > 16 ? event.title.slice(0, 16) + '...' : event.title}
      </text>

      <!-- Organization + Attendees -->
      <text
        x={cardX + 10}
        y={y + 26}
        font-size="11"
        fill="var(--color-text-secondary)"
      >
        {event.organization} | {event.attendees} 人
      </text>
    {/each}
  </svg>
</div>

<noscript>
  <table>
    <caption>活動時間軸</caption>
    <thead>
      <tr><th>日期</th><th>活動</th><th>單位</th><th>參加人數</th></tr>
    </thead>
    <tbody>
      {#each sorted as event}
        <tr>
          <td>{event.date}</td>
          <td>{event.title}</td>
          <td>{event.organization}</td>
          <td>{event.attendees}</td>
        </tr>
      {/each}
    </tbody>
  </table>
</noscript>

<style>
  .timeline {
    width: 100%;
    overflow-x: auto;
  }

  .timeline svg {
    width: 100%;
    max-width: 600px;
    height: auto;
    display: block;
    margin-inline: auto;
  }

  @media (max-width: 640px) {
    .timeline svg {
      min-width: 500px;
    }
  }
</style>
