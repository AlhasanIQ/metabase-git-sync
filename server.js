import { fstat } from 'fs'
import * as FS from 'fs/promises'
import { join } from 'path'
import simpleGit from 'simple-git'

const RepoBuildPath = process.env.REPO_PATH ? process.env.REPO_PATH : 'repo'

/**
 * Login via user and password
 */
async function getSession () {
  const options = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: `{"username":"${process.env.METABASE_USER}","password":"${process.env.METABASE_PASSWORD}"}`
  }

  console.log('visiting ', '/api/session')
  const response = await fetch(
    `${process.env.METABASE_URL}/api/session`,
    options
  )
    .then((response) => response.json())
    .catch((err) => console.error(err))
  const token = response.id

  return token
}

/**
 * Requests collections tree.
 * Metabase currently serves the tree with /collection/tree
 *  a workaround is to build it manually via /collection/ flat list
 * @param {string} token
 * @returns
 */
async function getCollectionsTree (token) {
  const options = {
    method: 'GET',
    headers: {
      'X-Metabase-Session': token
    }
  }

  console.log('visiting ', '/api/collection/tree?tree=true')
  const response = await fetch(
    `${process.env.METABASE_URL}/api/collection/tree?tree=true`,
    options
  )
    .then((response) => response.json())
    .catch((err) => console.error(err))

  return response
}

/**
 * Recursivly, generates HTTP requests.
 * Assumes no revisit is possible by hierarchy. (provides no protection against circular)
 * recursive when response.data[i].model == "collection"
 *          then response.data[i]._items = getCollectionItems(token, item.id);
 */
async function getCollectionItems (token, id) {
  const options = {
    method: 'GET',
    headers: {
      'X-Metabase-Session': token
    }
  }

  console.log('visiting ', '/api/collection/' + id + '/items')
  const response = await fetch(
    `${process.env.METABASE_URL}/api/collection/${id}/items`,
    options
  )
    .then((response) => response.json())
    .catch((err) => console.error(err))
  for (let i = 0; i < response.data.length; i++) {
    const item = response.data[i]
    if (item.model === 'collection') {
      item._items = await getCollectionItems(token, item.id)
    }
  }
  return response.data
}

/**
 * Requests the collections tree, and then requests CollectionItems recursively.
 * @param {string} token
 * @returns tree branching via `tree[i]._items`
 */
async function buildTree (token) {
  const tree = await getCollectionsTree(token)
  for (let i = 0; i < tree.length; i++) {
    const node = tree[i]
    node._items = await getCollectionItems(token, node.id)
  }
  return tree
}

async function getCards (token) {
  console.log('visiting ', '/api/card')
  const response = await fetch(
    `${process.env.METABASE_URL}/api/card/`,
    {
      method: 'GET',
      headers: {
        'X-Metabase-Session': token
      }
    }
  )
    .then((response) => response.json())
    .catch((err) => console.error(err))

  // cardMap [id]node+sql
  const cardMap = {}

  // iterate over cards to enrich serialized form
  for (let i = 0; i < response.length; i++) {
    if (response[i].query_type === 'native') {
      response[i]._serial = response[i].dataset_query?.native?.query
    } else if (response[i].query_type === 'query') {
      console.log('visiting /api/dataset/native to build sql from query builder')
      const body = JSON.stringify(response[i].dataset_query, null, 2)
      // console.log('body is ', body)
      const sqlResponse = await fetch(
        `${process.env.METABASE_URL}/api/dataset/native`,
        {
          method: 'POST',
          headers: {
            'X-Metabase-Session': token,
            'Content-Type': 'application/json'
          },
          body
        }
      )
        .then((response) => response.json())
        .catch((err) => console.error(err))
      response[i]._serial = sqlResponse.query
    } else {
      console.error('unsupported serializer for card: ', response[i])
    }

    cardMap[response[i].id] = response[i]
  }
  return cardMap
}

// FS CODE
/** Writes tree node to FS.
 * Recursive via node._items when node is a collection not a card (when ._items.model == 'collection')
 * Tree nodes are either collections or cards of different types (different node.model)
 */
async function writeNode (cardPathMapper, cardMap, node, path) {
  // if collection, write as mkdir, record dir/collection-[id]-metadata.json, and recursively follow ._items
  if ('_items' in node || node.model === 'collection') {
    let folderName = node.id
    if (node.slug) {
      folderName = `${node.id}-${node.slug}`
    }
    await FS.mkdir(join(path, folderName), {
      recursive: true
    }).catch((reason) => {
      console.error('Could not mkdir', folderName, reason)
    })
    await FS.writeFile(
      join(path, folderName, `collection-${node.id}-metadata.json`),
      JSON.stringify(node, null, 2)
    ).catch((reason) => {
      console.error('Could not writeFile collection metadata', reason)
    })

    for (let j = 0; j < node._items.length; j++) {
      const child = node._items[j]
      await writeNode(
        cardPathMapper,
        cardMap,
        child,
        join(path, folderName)
      )
    }
  } else {
    // if card in any non collection .model type, write [model]-[id].json, then look for sql (serial form) in cardMap, if found, write [model]-[id].sql

    if (!(node.id in cardMap)) {
      return console.error(
        'Error. Cannot write node without id.',
        node
      )
    }
    await FS.writeFile(
      `${path}/${node.model}-${node.id}-metadata.json`,
      JSON.stringify(node, null, 2)
    ).catch((reason) => {
      console.error('Could not write metadata file.', reason)
    })

    // add to map
    cardPathMapper[node.id] = path

    const cardNode = cardMap[node.id]
    node._card = cardMap[node.id]
    if (cardNode._serial) {
      await FS.writeFile(
        join(path, `${node.model}-${node.id}.sql`),
        cardNode._serial
      ).catch((reason) => {
        console.error('Could not write sql file.', reason)
      })
    } else {
      console.error(
        'unserialized card cant be written for node: ',
        node.id,
        cardNode
      )
    }
  }
}

/**
 * Initiator of writing tree on fs
 * Due to absence of root node, buildFS iterates, and writeNode recurses
 * @returns cardPathMapper [node id] path
 */
async function buildFS (tree, cardMap) {
  const cardPathMapper = {}
  for (let i = 0; i < tree.length; i++) {
    const node = tree[i]
    await writeNode(cardPathMapper, cardMap, node, RepoBuildPath)
  }
  return cardPathMapper
}

/**
 * @returns SimpleGit instance
 */
async function setupGit (repoPath) {
  const git = await simpleGit({
    baseDir: repoPath,
    binary: 'git'
  })
  return git
}

// GIT Operations Code

/**
 * Initializes repo `git init`
 */
async function gitInitRepo (git) {
  console.log('Initializing repo')
  try {
    const initResult = await git.init()
    return initResult
  } catch (error) {
    console.error('error initing repo: ', repoPath, error)
  }
}

/**
 * Equivalent to `git add . && git commit`
 * @returns commit result or null.
 *
 * Example commit result:
 * {
 *     author: null,
 *     branch: "master",
 *     commit: "21c3d7adbb1a30755d84de6d9ce5ba53f35e0cea",
 *     root: true,
 *     summary: {
 *       changes: 990,
 *       insertions: 37995,
 *       deletions: 0
 *     }
 *   }
 */
async function gitCommitAll (git, msg) {
  await git.add('.')
  const commitResult = await git.commit(
    msg
  ).catch((reason) => {
    console.error('could not commit', reason)
  })
  if (commitResult.commit) {
    console.log('Added commit', commitResult.commit, msg)
    return commitResult
  }
  return null
}

async function gitGetHeadCommit (git) {
  const latestCommit = await git.raw('rev-parse', 'HEAD')
  return latestCommit.trim()
}

function assertEnv () {
  const requiredItems = [
    'METABASE_URL',
    'METABASE_USER',
    'METABASE_PASSWORD'
  ]
  for (let i = 0; i < requiredItems.length; i++) {
    const item = requiredItems[i]
    if (!(item in process.env)) {
      console.error(`ENV VAR ${item} is required`)
      return false
    }
  }
  return true
}

function wantsArchive () {
  return process.argv.includes('--archive')
}
async function shouldArchive (fileName) {
  const fileExists = await FS.exists(fileName)
  return wantsArchive() && !fileExists
}

if (!assertEnv()) {
  process.exit()
}

const repoPath = join(process.cwd(), RepoBuildPath)
const token = await getSession()
const tree = await buildTree(token)
const cardMap = await getCards(token)
const cardPathMap = await buildFS(tree, cardMap)

const git = await setupGit(repoPath)
let freshRepo = false
try {
  await FS.access(join(repoPath, '.git'))
  console.log('Found git repo at', join(repoPath, '.git'))
} catch (error) {
  console.log("Couldn't find git repo at", join(repoPath, '.git'), 'Will initialize repo.')
  freshRepo = true
  await gitInitRepo(git)
}

// Commit
let commitMsg = 'Sync Metabase Git'
let commitResult = null
if (freshRepo) {
  commitMsg = 'Init Metabase Git Migration'
} else {
  // TODO if !needs commit, then log and stop execution
  //      currently bruteforcing via gitCommitAll
}

commitResult = await gitCommitAll(git, commitMsg)
if (commitResult === null) {
  console.log('Did not commit anything.')
  const latestCommit = await gitGetHeadCommit(git)
  commitResult = { commit: latestCommit }
}
const archiveFileName = `metabase-git-sync-${commitResult.commit}.zip`
if (shouldArchive(archiveFileName)) {
  // Archive to Zip
  await git.raw('archive', '--format=zip', '--prefix=metabase-git-sync/', '--output=../' + archiveFileName, 'HEAD')
    .then(() => console.log('Archive created: ./' + archiveFileName))
    .catch((reason) => console.error('Could not git archive.', reason))
}

// TODO safeguard version untested warning.

// TODO git push
// TODO dockerize to fit within cicd
// TODO split commit to multi commits based on file with author info, use cardPathMap
