// api/proxy.js
export default async function handler(req, res) {
  const path = req.url.replace(/^\/api/, '') || '/';
  const targetUrl = `https://milesspace.onrender.com/api${path}`;

  const response = await fetch(targetUrl, {
    method: req.method,
    headers: {
      'Content-Type': 'application/json',
      'Cookie': req.headers.cookie || '',
    },
    body: ['GET', 'HEAD'].includes(req.method) ? undefined : JSON.stringify(req.body)
  });

  const setCookie = response.headers.get('set-cookie');
  if (setCookie) res.setHeader('set-cookie', setCookie);

  const data = await response.text();
  res.status(response.status).send(data);
}