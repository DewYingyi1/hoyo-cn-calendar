import { githubApi, localToken, REPO } from '../lib/github.mjs';
const token = localToken();
const runs = await githubApi(`/repos/${REPO}/actions/runs?per_page=5`, { token });
console.log(JSON.stringify(runs.workflow_runs.map(run => ({ id: run.id, status: run.status, conclusion: run.conclusion, url: run.html_url, sha: run.head_sha })), null, 2));
for (const run of runs.workflow_runs.slice(0, 1)) {
  const jobs = await githubApi(`/repos/${REPO}/actions/runs/${run.id}/jobs`, { token });
  console.log(JSON.stringify(jobs.jobs.map(job => ({ name: job.name, conclusion: job.conclusion, steps: job.steps.map(step => ({ name: step.name, conclusion: step.conclusion })) })), null, 2));
}
