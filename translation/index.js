const express = require('express');
const translate = require('@vitalets/google-translate-api');
const dotenv = require('dotenv');
const log = require('npmlog');
const { JSDOM } = require('jsdom');

const TARGET_NODE_NAMES = ['div', 'em', 'span', 'a', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'p', 'i', 'strong', 'b', 'del', 's', 'blockquote', 'code'].map(tag => tag.toUpperCase());
const TEXT_NODE_NAME = '#text';

const UNKNOWN_LANGUAGE = 'unknown';

const env = process.env.NODE_ENV || 'development';

dotenv.config({
  path: env === 'production' ? '.env.production' : '.env',
});

log.level = process.env.LOG_LEVEL || 'verbose';

const port = process.env.PORT || 5000;

const languages = translate.languages;
languages['zh-cn'] = languages['zh-CN'];
languages['zh-tw'] = languages['zh-TW'];
languages['zh-hk'] = languages['zh-TW'];
languages['zh-HK'] = languages['zh-TW'];

/**
 *
 * @param {string} query
 * @param {string} to
 * @param {string} tld
 * @returns {Promise<{from: string, text}>}
 */
const translation = async (query, to, tld) => {
  if (!query) return { from: '', text: '' };

  const res = await translate(query, { to, tld });

  return {
    text: res.text, from: res.from.language.iso,
  };
};

/**
 * `ChildNode` recursive handler
 * @param {ChildNode} node
 * @param {Array.<ChildNode>} stack
 * @return {Array.<ChildNode>}
 */
const childNodeHandler = (node, stack = []) => {
  if (node.nodeName === TEXT_NODE_NAME) {
    if (node.textContent.trim()) {
      stack.push(node);
    }
  } else if (TARGET_NODE_NAMES.includes(node.nodeName)) {
    node.childNodes.forEach(child => {
      childNodeHandler(child, stack);
    });
  }

  return stack;
};

/**
 * Display language name
 * @param {string} code
 * @param {string} locale
 * @return {Promise<string>}
 */
const getLanguageDisplayName = (code, locale) => {
  return new Intl.DisplayNames([locale], { type: 'language' }).of(code);
};

/**
 * Guess language percentages
 * @param {Array.<string>} languages
 * @param {string} locale to display language name in locale
 * @return {{percentage: string, language}[]}
 */
const guessLanguage = (languages, locale) => {
  const counts = {};

  for (const num of languages) {
    counts[num] = counts[num] ? counts[num] + 1 : 1;
  }

  return Object.entries(counts)
    // eslint-disable-next-line no-unused-vars
    .sort(([_a, a], [_b, b]) => Number(b) - Number(a))
    .map(([key, count]) => {
      let percentage = count / languages.length * 1000;
      percentage = Math.round(percentage);
      percentage = Math.max(percentage, 1);
      percentage /= 10;
      return {
        language: key || UNKNOWN_LANGUAGE,
        percentage: `${percentage}%`,
        displayName: getLanguageDisplayName(key, locale),
      };
    });
};

/**
 * Handle query string trilling and beginning spaces
 * @param {string} query
 * @return {{beginningSpace: boolean, trillingSpace: boolean, query: string}}
 */
const querySpaceHandler = query => {
  let beginningSpace = false;
  let trillingSpace = false;
  if (query.startsWith(' ')) {
    beginningSpace = true;
    query = query.slice(1);
  }
  if (query.endsWith(' ')) {
    trillingSpace = true;
    query = query.slice(0, -1);
  }
  return { query, beginningSpace, trillingSpace };
};

/**
 * Handle query string trilling and beginning spaces
 * @param {string} result
 * @param {boolean} beginningSpace
 * @param {boolean} trillingSpace
 * @return {string}
 */
const resultHandler = (result, beginningSpace, trillingSpace) => {
  result = result.replace(/\s+$/, '');
  result = result.replace(/^\s+/, '');
  result = `${beginningSpace ? ' ' : ''}${result}${trillingSpace ? ' ' : ''}`;
  result = result.replace(/：\s$/, '：');
  return result;
};

const app = express();

app.use(express.json());

app.get('/health', (_request, response) => {
  log.verbose('[success]', 'health check');

  response.json({
    status: 'OK',
  });
});

app.post('*', async (request, response) => {
  // console.log(JSON.stringify([request.headers, request.body], null, 2));
  const body = request.body;

  const { content, to, status, edit } = body;

  if (!content) {
    response.status(400).send({
      message: 'Empty Content', emptyContent: true,
    });
    return;
  }

  if (!to) {
    response.status(400).send({
      message: 'Empty To', emptyTo: true,
    });
    return;
  }

  const tld = body.tld || 'com';

  const batch = body.batch ?? true;

  const logger = { to, status, edit, batch, tld };

  try {
    const stack = [];

    const fragment = JSDOM.fragment(`<div>${content}</div>`);

    fragment.childNodes.forEach(node => {
      childNodeHandler(node, stack);
    });

    const languages = [];

    if (batch) {
      const batchStack = [];

      stack.forEach((node, nodeIndex) => {
        const lines = node.textContent.split('\n');

        lines.forEach(line => {
          const { query, beginningSpace, trillingSpace } = querySpaceHandler(line);
          batchStack.push({ node, query, beginningSpace, trillingSpace, nodeIndex });
        });
      });

      const batchQuery = batchStack.map(item => item.query).join('\n');

      const { from, text } = await translation(batchQuery, to, tld);

      const batchResults = text.split('\n');

      const resultStack = [];

      batchResults.forEach((result, index) => {
        const { node, nodeIndex, beginningSpace, trillingSpace } = batchStack[index];

        result = resultHandler(result, beginningSpace, trillingSpace);

        if (!resultStack[nodeIndex]) {
          resultStack[nodeIndex] = { result, node };
        } else {
          resultStack[nodeIndex].result += `/n${result}`;
        }
      });

      resultStack.forEach(process => {
        process.node.textContent = process.result;
      });

      languages.push(from);
    } else {
      await Promise.all(stack.map(async node => {
        const { query, beginningSpace, trillingSpace } = querySpaceHandler(node.textContent);

        const { text, from } = await translation(query, to, tld);

        node.textContent = resultHandler(text, beginningSpace, trillingSpace);

        languages.push(from);
      }));
    }

    const from = guessLanguage(languages, to);
    // from.push({ language:UNKNOWN_LANGUAGE, percentage:'100%', displayName:getLanguageDisplayName(UNKNOWN_LANGUAGE, to) });

    const unknownLanguage = from.find(item => item.language === UNKNOWN_LANGUAGE);

    if (unknownLanguage) {
      const req = await translation('Unknown language', to, tld);
      unknownLanguage.displayName = req.text;
    }

    if(env==='development'){
      logger.content = content;
    }

    log.verbose('[success]', JSON.stringify(logger));

    response.json({
      text: fragment.firstChild.innerHTML, from, to,
    });
  } catch (err) {
    logger.error = err;
    logger.content = content;
    log.error('[error]', JSON.stringify(logger));

    response.status(400).send({
      message: err.toString(),
    });
  }
});

app.listen(port, () => log.warn(`Translation API server is now listening on port ${port}`));
