const axios = require('axios');
const moment = require('moment');
const configManager = require('./configManager');
const emoji = require('./emoji');

function apiCall(url, headers = {}) {
  const config = configManager.getConfig();
  const options = { headers };
  if (config.username && config.password) {
    options.auth = {
      username: config.username,
      password: config.password
    }
  } else if (config.token ) {
    options.auth = {
      username: config.token
    }
  };

  return axios.get(url, options);
}

function getPullRequests(repos) {
  const config = configManager.getConfig();

  let pullRequests = [];
  const promises = repos.map(repo => apiCall(`${config.apiBaseUrl}/repos/${repo}/pulls`));
  return Promise.all(promises).then(results => {
    results.forEach(result => {
      pullRequests = pullRequests.concat(result.data);
    });

    return pullRequests.map(pr => ({
      url: pr.html_url,
      id: pr.id,
      number: pr.number,
      title: pr.title,
      repo: pr.base.repo.full_name,
      repoUrl: pr.base.repo.html_url,
      repoId: pr.base.repo.id,
      user: {
        username: pr.user.login,
        profileUrl: pr.user.html_url,
        avatarUrl: pr.user.avatar_url
      },
      created: pr.created_at,
      updated: pr.updated_at,
      comments_url: pr.comments_url,
      statuses_url: pr.statuses_url
    }));
  });
}

function getPullRequestComments(pr) {
  return apiCall(pr.comments_url).then(comments => {
    pr.comments = comments.data.map(comment => ({
      body: comment.body,
      user: comment.user.login
    }));

    pr.positiveComments = emoji.countPositiveComments(comments.data);
    pr.negativeComments = emoji.countNegativeComments(comments.data);

    delete pr.comments_url;
  });
}

function getPullRequestReactions(pr) {
  const config = configManager.getConfig();
  return apiCall(`${config.apiBaseUrl}/repos/${pr.repo}/issues/${pr.number}/reactions`, {
    Accept: 'application/vnd.github.squirrel-girl-preview'
  }).then(reactions => {
    pr.reactions = emoji.getOtherReactions(reactions.data).map(reaction => ({
      user: reaction.user.login,
      content: reaction.content
    }));

    pr.positiveComments += emoji.countPositiveReactions(reactions.data);
    pr.negativeComments += emoji.countNegativeReactions(reactions.data);
  });
}

function getPullRequestReviews(pr) {
  const config = configManager.getConfig();
  return apiCall(`${config.apiBaseUrl}/repos/${pr.repo}/pulls/${pr.number}/reviews`, {
    Accept: 'application/vnd.github.squirrel-girl-preview'
  }).then(reviews => {
    pr.positiveReviews = reviews.data.reduce((total, review) => {
      return total + (review.state === 'APPROVED' ? 1 : 0)
    }, 0)
    pr.negativeReviews = reviews.data.reduce((total, review) => {
      return total + (review.state === 'CHANGES_REQUESTED' ? 1 : 0)
    }, 0)
  });
}

function getPullRequestStatus(pr) {
  return apiCall(pr.statuses_url).then(statuses => {
    if (statuses.data.length) {
      pr.status = {
        state: statuses.data[0].state,
        description: statuses.data[0].description
      };
    }
    delete pr.statuses_url;
  });
}

exports.getRepo = function getRepo(owner, name) {
  const config = configManager.getConfig();
  return apiCall(`${config.apiBaseUrl}/repos/${owner}/${name}`);
};

exports.loadPullRequests = function loadPullRequests() {
  const config = configManager.getConfig();
  const repos = config.repos;

  return getPullRequests(repos)
  .then(prs => {
    const reviewsPromises = prs.map(pr => getPullRequestReviews(pr));
    return Promise.all(reviewsPromises).then(() => prs);
  })
  .then(prs => prs.filter(pr => pr.positiveReviews === 0 || pr.negativeReviews > 0))
  .then(prs => {
    const commentsPromises = prs.map(pr => getPullRequestComments(pr));
    return Promise.all(commentsPromises).then(() => prs);
  })
  .then(prs => {
    const reactionsPromises = prs.map(pr => getPullRequestReactions(pr));
    return Promise.all(reactionsPromises).then(() => prs);
  })
  .then(prs => {
    const statusPromises = prs.map(pr => getPullRequestStatus(pr));
    return Promise.all(statusPromises).then(() => prs);
  })
  .then(prs => {
    prs.sort((p2, p1) => new Date(p2.updated).getTime() - new Date(p1.updated).getTime());
    if (configManager.hasMergeRules()) {
      prs.forEach(pr => {
        if (config.mergeRule.neverRegexp && configManager.getNeverMergeRegexp().test(pr.title)) {
          pr.unmergeable = true;
        } else if (pr.positiveComments >= config.mergeRule.positive &&
            pr.negativeComments <= config.mergeRule.negative) {
          pr.mergeable = true;
        } else if(moment(pr.created).isBefore(moment().subtract(7, "days"))) {
          pr.unmergeable = true;
        }
      });
    }
    return prs;
  });
};
