const { test, expect } = require('@playwright/test');

for (const width of [390, 1280]) {
  test(`upload controls share typography and fit both apps at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    const styles = [];
    for (const app of ['planning-poker', 'poll']) {
      await page.goto('/' + app);
      if (app === 'poll') {
        await page.getByTestId('question-input').fill('Shared controls');
        await page.getByTestId('option-input').nth(0).fill('A');
        await page.getByTestId('option-input').nth(1).fill('B');
      }
      await page.getByTestId('create-btn').click();
      await page.getByTestId('custom-wife').click();
      const panel = page.getByTestId('custom-panel');
      const result = await panel.evaluate(e => {
        const typography = x => {
          const s = getComputedStyle(x);
          return { fontSize: s.fontSize, weight: s.fontWeight, letterSpacing: s.letterSpacing, textTransform: s.textTransform, margin: s.margin, padding: s.padding };
        };
        const row = e.querySelector('.bwp-pic-row');
        const controls = [...row.children].map(x => x.getBoundingClientRect());
        const bounds = row.getBoundingClientRect();
        return {
          label: typography(e.querySelector('.bwp-field label')),
          upload: typography(e.querySelector('.bwp-file')),
          url: typography(row.querySelector('input[type=url]')),
          rowFits: controls.every(r => r.left >= bounds.left - 1 && r.right <= bounds.right + 1),
          heights: controls.map(r => r.height),
        };
      });
      expect(result.rowFits).toBe(true);
      expect(result.upload.textTransform).toBe('none');
      expect(result.upload.margin).toBe('0px');
      expect(Math.max(...result.heights) - Math.min(...result.heights)).toBeLessThan(1);
      styles.push(result);
    }
    expect(styles[1]).toEqual(styles[0]);
  });
}
