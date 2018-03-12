const crypto = require('crypto')
const co = require('co').wrap
const Koa = require('koa')
const bodyParser = require('koa-body')
const Router = require('koa-router')
const port = Number(process.argv[2] || 8000)
const hmacSecret = process.argv[3]

const getBody = () => co(function* (ctx, next) {
  console.log('getting body...')
  const { req } = ctx
  ctx.request.body = yield new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', data => chunks.push(data))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })

  yield next()
})

const checkHmac = (secret) => co(function* (ctx, next) {
  console.log('checking hmac...')
  const { body } = ctx.request
  const expected = ctx.req.headers['x-webhook-auth']
  if (!expected) throw new Error('expected hmac in x-webhook-auth header')

  const actual = crypto
    .createHmac('sha1', secret)
    .update(body)
    .digest('hex')

  if (expected !== actual) {
    console.error('invalid hmac')
    throw new Error('invalid hmac')
  }

  yield next()
})

const handleEvent = co(function* (ctx) {
  const { headers } = ctx.request
  try {
    console.log('received event', JSON.parse(ctx.request.body))
    // yield saveEventSomewhere()
    ctx.status = 200
  } catch (err) {
    console.log('simulating failure to receive, expecting retry')
    yield new Promise(resolve => setTimeout(resolve, 2000))
    ctx.status = 500
  }
})

const app = new Koa()

app.use(bodyParser())
app.use(getBody())
if (hmacSecret) {
  app.use(checkHmac(hmacSecret))
}

const router = new Router()
router.post('/', handleEvent)
app.use(router.routes())
app.listen(port)

console.log(`listening on port ${port}`)
if (hmacSecret) {
  console.log(`will verify with hmac secret: ${hmacSecret}`)
}
