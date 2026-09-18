import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';

import { chromium, test } from '@playwright/test';

/**
 * 视觉读图能力基准：生成一批“有标准答案”的图表截图，供 scripts/vision-bench.py 打分。
 *
 * 目的：在决定是否把视觉纳入产品之前，先拿到“读图表数字准不准”的真实数字。
 * 图表全部是内联 SVG，数值由本文件构造，所以正确答案是确定的。
 *
 *   npx playwright test tests/e2e/chart-fixture.spec.ts
 *   python3 scripts/vision-bench.py          # 需要 DEEPSEEK_KEY
 */

const OUTPUT_DIR = resolve(process.cwd(), '.bench/charts');

type Chart = {
  id: string;
  /** 正确答案：图中出现的全部数值。 */
  truth: number[];
  /** 这张图考的是什么。 */
  note: string;
  html: string;
};

const bar = (x: number, y: number, w: number, h: number, fill: string) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}"/>`;
const label = (x: number, y: number, text: string, size = 12, anchor = 'middle') =>
  `<text x="${x}" y="${y}" font-size="${size}" text-anchor="${anchor}" fill="#333" font-family="sans-serif">${text}</text>`;

function groupedBarChart(): string {
  const data = [80, 100, 120];
  const names = ['甲方案', '乙方案', '丙方案'];
  const bars = data
    .map((value, index) => {
      const h = value * 1.6;
      const x = 60 + index * 120;
      return (
        bar(x, 220 - h, 70, h, '#8a3b12') +
        label(x + 35, 214 - h, String(value)) +
        label(x + 35, 240, names[index] ?? '')
      );
    })
    .join('');
  return `<svg width="420" height="260" viewBox="0 0 420 260">
    <line x1="40" y1="220" x2="400" y2="220" stroke="#999"/>
    <line x1="40" y1="40" x2="40" y2="220" stroke="#999"/>
    ${label(210, 24, '三种方案的平均处理时间（分钟）', 13)}
    ${bars}
  </svg>`;
}

function decimalBarChart(): string {
  const data = [12.3, 45.6, 78.9, 23.4, 56.7];
  const bars = data
    .map((value, index) => {
      const h = value * 2;
      const x = 50 + index * 70;
      return bar(x, 210 - h, 44, h, '#2f6f8f') + label(x + 22, 205 - h, String(value), 11);
    })
    .join('');
  return `<svg width="420" height="250" viewBox="0 0 420 250">
    <line x1="36" y1="210" x2="410" y2="210" stroke="#999"/>
    ${label(210, 20, '各地区渗透率（%）', 13)}
    ${bars}
  </svg>`;
}

function lineChart(): string {
  const data = [10, 25, 18, 40, 33, 52];
  const points = data
    .map((value, index) => `${60 + index * 60},${220 - value * 3}`)
    .join(' ');
  const dots = data
    .map((value, index) => {
      const x = 60 + index * 60;
      const y = 220 - value * 3;
      return `<circle cx="${x}" cy="${y}" r="3" fill="#8a3b12"/>` + label(x, y - 8, String(value), 11);
    })
    .join('');
  return `<svg width="440" height="250" viewBox="0 0 440 250">
    <line x1="40" y1="220" x2="420" y2="220" stroke="#999"/>
    ${label(220, 20, '上半年月度新增用户（千人）', 13)}
    <polyline points="${points}" fill="none" stroke="#8a3b12" stroke-width="2"/>
    ${dots}
  </svg>`;
}

function pieChart(): string {
  const slices = [
    { value: 45, color: '#8a3b12' },
    { value: 30, color: '#2f6f8f' },
    { value: 15, color: '#6b8f5a' },
    { value: 10, color: '#b98a2a' },
  ];
  let angle = -Math.PI / 2;
  const paths = slices
    .map((slice) => {
      const sweep = (slice.value / 100) * Math.PI * 2;
      const x1 = 130 + 100 * Math.cos(angle);
      const y1 = 130 + 100 * Math.sin(angle);
      angle += sweep;
      const x2 = 130 + 100 * Math.cos(angle);
      const y2 = 130 + 100 * Math.sin(angle);
      const mid = angle - sweep / 2;
      const tx = 130 + 62 * Math.cos(mid);
      const ty = 130 + 62 * Math.sin(mid);
      return (
        `<path d="M130,130 L${x1},${y1} A100,100 0 ${sweep > Math.PI ? 1 : 0},1 ${x2},${y2} Z" fill="${slice.color}"/>` +
        label(tx, ty + 4, `${slice.value}%`, 12)
      );
    })
    .join('');
  return `<svg width="420" height="270" viewBox="0 0 420 270">
    ${label(210, 20, '用户来源占比', 13)}
    ${paths}
  </svg>`;
}

function stackedBarChart(): string {
  const a = [20, 30, 25];
  const b = [15, 25, 20];
  const bars = a
    .map((value, index) => {
      const x = 60 + index * 110;
      const h1 = value * 3;
      const h2 = (b[index] ?? 0) * 3;
      return (
        bar(x, 220 - h1, 60, h1, '#8a3b12') +
        bar(x, 220 - h1 - h2, 60, h2, '#c9a227') +
        label(x + 30, 214 - h1, String(value), 11) +
        label(x + 30, 208 - h1 - h2, String(b[index]), 11) +
        label(x + 30, 240, `第${index + 1}季度`)
      );
    })
    .join('');
  return `<svg width="420" height="260" viewBox="0 0 420 260">
    <line x1="40" y1="220" x2="400" y2="220" stroke="#999"/>
    ${label(210, 20, '各季度收入构成（万元）', 13)}
    ${bars}
  </svg>`;
}

function truncatedAxisChart(): string {
  const data = [82, 88, 95];
  const bars = data
    .map((value, index) => {
      const h = (value - 80) * 9;
      const x = 60 + index * 120;
      return bar(x, 220 - h, 70, h, '#2f6f8f') + label(x + 35, 214 - h, String(value));
    })
    .join('');
  return `<svg width="420" height="260" viewBox="0 0 420 260">
    <line x1="40" y1="220" x2="400" y2="220" stroke="#999"/>
    ${label(210, 20, '满意度得分（纵轴自 80 起）', 12)}
    ${label(30, 224, '80', 10, 'end')}
    ${bars}
  </svg>`;
}

function closeValuesChart(): string {
  const data = [100, 102, 104];
  const bars = data
    .map((value, index) => {
      const h = (value - 98) * 20;
      const x = 60 + index * 120;
      return bar(x, 220 - h, 70, h, '#6b8f5a') + label(x + 35, 214 - h, String(value));
    })
    .join('');
  return `<svg width="420" height="260" viewBox="0 0 420 260">
    <line x1="40" y1="220" x2="400" y2="220" stroke="#999"/>
    ${label(210, 20, '三次测量的响应时间（毫秒）', 12)}
    ${bars}
  </svg>`;
}

const CHARTS: Chart[] = [
  { id: '01-bar-easy', truth: [80, 100, 120], note: '三柱，大字，简单', html: groupedBarChart() },
  { id: '02-bar-decimal', truth: [12.3, 45.6, 78.9, 23.4, 56.7], note: '五柱，带小数，字号小', html: decimalBarChart() },
  { id: '03-line', truth: [10, 25, 18, 40, 33, 52], note: '折线，六点，数值标在点上', html: lineChart() },
  { id: '04-pie', truth: [45, 30, 15, 10], note: '饼图，四块，百分比', html: pieChart() },
  { id: '05-stacked', truth: [20, 30, 25, 15, 25, 20], note: '堆叠柱，两组数字', html: stackedBarChart() },
  { id: '06-truncated-axis', truth: [82, 88, 95], note: '纵轴被截断（不从 0 开始）', html: truncatedAxisChart() },
  { id: '07-close-values', truth: [100, 102, 104], note: '三个数值很接近，考验分辨力', html: closeValuesChart() },
];

/** 密集图表：12 根柱子、标签旋转、带网格线——接近真实数据看板。 */
function denseBarChart(): string {
  const data = [34, 52, 41, 67, 28, 73, 59, 46, 81, 38, 62, 55];
  const bars = data
    .map((value, index) => {
      const h = value * 1.9;
      const x = 34 + index * 30;
      return (
        bar(x, 200 - h, 20, h, '#2f6f8f') +
        `<text x="${x + 10}" y="${195 - h}" font-size="9" text-anchor="middle" fill="#333" font-family="sans-serif">${value}</text>` +
        `<text x="${x + 10}" y="214" font-size="8" text-anchor="end" fill="#555" font-family="sans-serif" transform="rotate(-60 ${x + 10} 214)">${index + 1}月</text>`
      );
    })
    .join('');
  const grid = [0, 25, 50, 75, 100]
    .map((value) => {
      const y = 200 - value * 1.9;
      return `<line x1="24" y1="${y}" x2="400" y2="${y}" stroke="#e2e2e2"/>` +
        `<text x="20" y="${y + 3}" font-size="8" text-anchor="end" fill="#888" font-family="sans-serif">${value}</text>`;
    })
    .join('');
  return `<svg width="420" height="240" viewBox="0 0 420 240">
    ${grid}${bars}
    <line x1="24" y1="200" x2="400" y2="200" stroke="#999"/>
  </svg>`;
}

/** 深色背景 + 图例 + 两条线：真实的仪表盘常见形态。 */
function darkLineChart(): string {
  const a = [12, 19, 15, 27, 22, 31];
  const b = [8, 11, 17, 14, 25, 20];
  const path = (data: number[], color: string) => {
    const points = data.map((v, i) => `${50 + i * 62},${200 - v * 4.5}`).join(' ');
    const dots = data
      .map((v, i) => {
        const x = 50 + i * 62;
        const y = 200 - v * 4.5;
        return `<circle cx="${x}" cy="${y}" r="2.5" fill="${color}"/>` +
          `<text x="${x}" y="${y - 7}" font-size="9" text-anchor="middle" fill="#ddd" font-family="sans-serif">${v}</text>`;
      })
      .join('');
    return `<polyline points="${points}" fill="none" stroke="${color}" stroke-width="2"/>${dots}`;
  };
  return `<svg width="420" height="240" viewBox="0 0 420 240">
    <rect width="420" height="240" fill="#1e1e24"/>
    <rect x="230" y="16" width="10" height="10" fill="#e0a030"/>
    <text x="246" y="25" font-size="10" fill="#ddd" font-family="sans-serif">新方案</text>
    <rect x="310" y="16" width="10" height="10" fill="#4f9fd8"/>
    <text x="326" y="25" font-size="10" fill="#ddd" font-family="sans-serif">原方案</text>
    ${path(a, '#e0a030')}${path(b, '#4f9fd8')}
    <line x1="30" y1="200" x2="400" y2="200" stroke="#555"/>
  </svg>`;
}

/** 标签互相压住：真实图表里非常常见。 */
function overlappingLabelsChart(): string {
  const data = [128, 131, 129, 133, 130];
  const bars = data
    .map((value, index) => {
      const h = (value - 120) * 8;
      const x = 60 + index * 66;
      return bar(x, 190 - h, 52, h, '#6b8f5a') + label(x + 26, 184 - h, String(value), 11);
    })
    .join('');
  return `<svg width="420" height="230" viewBox="0 0 420 230">
    <line x1="40" y1="190" x2="400" y2="190" stroke="#999"/>
    ${label(210, 18, '五次抽检的合格数（纵轴自 120 起，柱高差异被放大）', 11)}
    ${bars}
  </svg>`;
}

/** 无数据标签：数值只能靠对着坐标轴估。真实图表里非常常见，也是最容易读错的一类。 */
function noLabelsChart(): string {
  const data = [40, 90, 160, 120];
  const bars = data
    .map((value, index) => {
      const h = value * 1.4;
      const x = 60 + index * 90;
      return bar(x, 220 - h, 56, h, '#2f6f8f');
    })
    .join('');
  const grid = [0, 50, 100, 150, 200]
    .map((value) => {
      const y = 220 - value * 1.4;
      return (
        `<line x1="50" y1="${y}" x2="410" y2="${y}" stroke="#ddd"/>` +
        label(44, y + 4, String(value), 10, 'end')
      );
    })
    .join('');
  return `<svg width="430" height="260" viewBox="0 0 430 260">
    <line x1="50" y1="220" x2="410" y2="220" stroke="#999"/>
    <line x1="50" y1="20" x2="50" y2="220" stroke="#999"/>
    ${grid}${bars}
    ${label(230, 16, '各季度销售额（万元）', 12)}
  </svg>`;
}

const HARD_CHARTS: Chart[] = [
  { id: '14-no-labels', truth: [40, 90, 160, 120], note: '无数据标签，只能对坐标轴估值', html: noLabelsChart() },
  { id: '09-dense', truth: [34, 52, 41, 67, 28, 73, 59, 46, 81, 38, 62, 55], note: '12 柱 + 旋转标签 + 网格线', html: denseBarChart() },
  { id: '10-dark', truth: [12, 19, 15, 27, 22, 31, 8, 11, 17, 14, 25, 20], note: '深色背景 + 图例 + 两条线', html: darkLineChart() },
  { id: '11-overlap', truth: [128, 131, 129, 133, 130], note: '数值接近 + 标签拥挤', html: overlappingLabelsChart() },
];

const PAGE = (svg: string) =>
  `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>图表基准</title>
   <style>body{margin:0;background:#fff;display:inline-block}</style></head>
   <body><div id="chart">${svg}</div></body></html>`;

test('生成图表基准截图', async () => {
  mkdirSync(OUTPUT_DIR, { recursive: true });
  const browser = await chromium.launch({ channel: 'chromium' });
  const page = await browser.newPage({ deviceScaleFactor: 1 });

  const manifest: { id: string; truth: number[]; note: string; file: string }[] = [];
  for (const chart of [...CHARTS, ...HARD_CHARTS]) {
    await page.setContent(PAGE(chart.html));
    const element = page.locator('#chart');
    const file = join(OUTPUT_DIR, `${chart.id}.png`);
    await element.screenshot({ path: file });
    manifest.push({ id: chart.id, truth: chart.truth, note: chart.note, file });
  }

  // 压缩版本：网页上的图表常以 JPEG 呈现，边缘会有噪点。
  await page.setContent(PAGE(groupedBarChart()));
  await page
    .locator('#chart')
    .screenshot({ path: join(OUTPUT_DIR, '12-jpeg.png'), type: 'jpeg', quality: 45 });
  manifest.push({
    id: '12-jpeg',
    truth: [80, 100, 120],
    note: '与图一相同，但存为低质量 JPEG（模拟压缩噪点）',
    file: join(OUTPUT_DIR, '12-jpeg.png'),
  });

  // 很小的图：真实页面上图表常常只有拇指大小。
  await page.setContent(
    PAGE(groupedBarChart().replace('width="420" height="260"', 'width="150" height="93"')),
  );
  await page.locator('#chart').screenshot({ path: join(OUTPUT_DIR, '13-tiny.png') });
  manifest.push({
    id: '13-tiny',
    truth: [80, 100, 120],
    note: '缩到 150px 宽（约真实页面缩略图大小）',
    file: join(OUTPUT_DIR, '13-tiny.png'),
  });

  // 缩略图版本：很多真实页面的图表只占一小块地方，字号会被压到几个像素。
  await page.setContent(
    PAGE(groupedBarChart().replace('width="420" height="260"', 'width="200" height="124"')),
  );
  await page.locator('#chart').screenshot({ path: join(OUTPUT_DIR, '08-thumbnail.png') });
  manifest.push({
    id: '08-thumbnail',
    truth: [80, 100, 120],
    note: '与图一相同，但被缩到 200px 宽（真实页面的小图）',
    file: join(OUTPUT_DIR, '08-thumbnail.png'),
  });

  writeFileSync(join(OUTPUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2));
  await browser.close();
});
