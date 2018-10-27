
import test from 'tape'
import sinon from 'sinon'
import { deriveRestoredResourceName } from '../restore'
import * as utils from '../utils'

test('derive resource name', t => {
  const sandbox = sinon.createSandbox()
  const rand = 'abcd'
  sandbox.stub(utils, 'randomAlphaNumericString').returns(rand)

  const stackName = 'tdl-blah1-ltd-dev'
  t.equal(deriveRestoredResourceName({
    stackName,
    type: 'bucket',
    name: 'objects',
    value: 'tdl-abracadabra-ltd-dev-buckets-1kkkta6xsthmf-objects-1hf8k2xvzdryw',
  }), `${stackName}-objects-${rand}-r1`, 'derive restored version name from original')

  t.equal(deriveRestoredResourceName({
    stackName,
    type: 'bucket',
    name: 'objectsbucket',
    value: 'tdl-abracadabra-ltd-dev-buckets-1kkkta6xsthmf-objects-1hf8k2xvzdryw',
  }), `${stackName}-objects-${rand}-r1`, 'strip resource type from name')

  t.equal(deriveRestoredResourceName({
    stackName,
    type: 'bucket',
    name: 'objectsbucket',
    value: 'tdl-abracadabra-ltd-dev-buckets-1kkkta6xsthmf-objects-1hf8k2xvzdryw-r1',
  }), `${stackName}-objects-${rand}-r2`, 'derive restored version name from previous restored version')

  t.equal(deriveRestoredResourceName({
    stackName,
    type: 'table',
    name: 'eventstable',
    value: 'tdl-abracadabra-ltd-dev-table-1kkkta6xsthmf-events-1hf8k2xvzdryw-r1',
  }), `${stackName}-events-r2`, 'add random suffix only for buckets')

  sandbox.restore()
  t.end()
})
