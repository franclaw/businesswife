const { test, expect } = require('@playwright/test');

for (const width of [1280, 390]) {
  test(`player portraits and vote boxes stay complete at ${width}px`, async ({ page, request }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto('/planning-poker');
    await page.getByTestId('create-btn').click();
    await page.locator('[data-testid="pick"][data-first="Charlotte"]').click();
    await page.getByTestId('join-btn').click();
    await expect(page.getByTestId('game-screen')).toBeVisible();
    const api = '/planning-poker/api/rooms/' + page.url().split('/').pop();
    for (const data of [
      { name: 'Fabiola – Koningin', icon: '/img/cfo.png' },
      { name: 'Truus Treurbuis', icon: '/img/secretary.png' },
      { name: 'Observer long name', icon: '👁️', role: 'observer' },
      { name: 'Custom wife', icon: '👑', subtitle: 'Closes deals before lunch' },
    ]) {
      expect((await request.post(api + '/join', { data })).ok()).toBeTruthy();
    }
    await expect(page.locator('.player')).toHaveCount(5);
    await page.locator('.player img').evaluateAll(imgs => Promise.all(imgs.map(img => img.decode())));

    for (const phase of ['voting', 'revealed']) {
      if (phase === 'revealed') await page.getByTestId('reveal-btn').click();
      const cards = await page.locator('.player').evaluateAll(els => els.map(el => {
        const rect = e => {
          const r = e.getBoundingClientRect();
          return { top: r.top, bottom: r.bottom, width: r.width, height: r.height };
        };
        const vote = el.querySelector('.vote');
        const portrait = el.querySelector('.pic, .ico');
        const name = el.querySelector('.nm');
        return {
          card: rect(el), vote: rect(vote), portrait: rect(portrait),
          voteDisplay: getComputedStyle(vote).display,
          imageFit: portrait.tagName === 'IMG' ? getComputedStyle(portrait).objectFit : null,
          nameClipped: name.scrollHeight > name.clientHeight,
          fullName: name.title,
        };
      }));
      for (const c of cards) {
        expect(c.voteDisplay).toBe('flex');
        expect(c.vote.height).toBeGreaterThanOrEqual(40);
        expect(c.vote.width).toBeCloseTo(c.card.width - 18, 1);
        expect(c.vote.bottom).toBeLessThanOrEqual(c.card.bottom - 12);
        expect(c.vote.top).toBeGreaterThanOrEqual(c.portrait.bottom);
        expect(c.portrait.height).toBe(96);
        if (c.imageFit) expect(c.imageFit).toBe('contain');
        if (c.nameClipped) expect(c.fullName.length).toBeGreaterThan(0);
      }
      const rows = Map.groupBy(cards, c => c.card.top);
      for (const row of rows.values()) {
        const bottoms = row.map(c => c.vote.bottom);
        expect(Math.max(...bottoms) - Math.min(...bottoms)).toBeLessThanOrEqual(0.1);
      }
    }
  });
}
