// BB selects its built-in Thread list unless the synced sidebar preference
// names another one. Pick Dusk (status) for this browser only; never write the
// user's synced preferences from a test.
export async function useStatusList(target) {
  await target.route('**/api/v1/preferences/ui/**', route =>
    route.request().method() === 'GET' ? route.continue() : route.fulfill({ json: { ok: true } }));
  await target.route('**/api/v1/preferences/ui', async route => {
    const response = await route.fetch();
    const body = await response.json();
    body.preferences = { ...body.preferences, 'sidebar.threadListProvider': 'dusk/status' };
    await route.fulfill({ response, json: body });
  });
}
