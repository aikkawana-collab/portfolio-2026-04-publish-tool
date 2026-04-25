/**
 * Repository Analyzer
 *
 * Extracts auto-detectable metadata from a cloned repository:
 * - Tech stack (from package.json, requirements.txt, go.mod, .gas, etc.)
 * - First/last commit dates
 * - File count, LOC estimate
 * - README content
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileExists, walkTextFiles } from './fs-util.mjs';

const execFileAsync = promisify(execFile);

/**
 * Analyze a cloned repo at rootPath
 * @returns { readme, techStack, firstCommit, lastCommit, loc, fileCount, packageInfo }
 */
export async function analyzeRepo(rootPath) {
  const result = {
    readme: null,
    techStack: new Set(),
    firstCommit: null,
    lastCommit: null,
    loc: 0,
    fileCount: 0,
    packageInfo: null,
    languages: new Set(),
    additionalDocs: [],
  };

  // 1. README
  for (const name of ['README.md', 'readme.md', 'README.MD', 'README']) {
    const p = path.join(rootPath, name);
    if (await fileExists(p)) {
      result.readme = await fs.readFile(p, 'utf8');
      break;
    }
  }

  // 2. Additional docs
  for (const name of ['DEPLOYMENT.md', 'PROJECT_NOTES.md', 'docs/REQUIREMENTS.md', 'docs/sdd/REQUIREMENTS.md']) {
    const p = path.join(rootPath, name);
    if (await fileExists(p)) {
      const content = await fs.readFile(p, 'utf8');
      result.additionalDocs.push({ name, content: content.slice(0, 5000) });
    }
  }

  // 3. package.json (Node.js)
  const pkgPath = path.join(rootPath, 'package.json');
  if (await fileExists(pkgPath)) {
    try {
      const pkg = JSON.parse(await fs.readFile(pkgPath, 'utf8'));
      result.packageInfo = {
        name: pkg.name,
        description: pkg.description,
        dependencies: Object.keys(pkg.dependencies || {}),
        devDependencies: Object.keys(pkg.devDependencies || {}),
      };
      // Detect tech from dependencies
      const allDeps = [
        ...Object.keys(pkg.dependencies || {}),
        ...Object.keys(pkg.devDependencies || {}),
      ];
      for (const dep of allDeps) {
        const tech = mapNpmDepToTech(dep);
        if (tech) result.techStack.add(tech);
      }
    } catch {}
  }

  // 4. requirements.txt (Python)
  const reqPath = path.join(rootPath, 'requirements.txt');
  if (await fileExists(reqPath)) {
    result.techStack.add('Python');
    const content = await fs.readFile(reqPath, 'utf8');
    if (/django/i.test(content)) result.techStack.add('Django');
    if (/flask/i.test(content)) result.techStack.add('Flask');
    if (/fastapi/i.test(content)) result.techStack.add('FastAPI');
  }

  // 5. .clasp.json (Google Apps Script)
  if (await fileExists(path.join(rootPath, '.clasp.json'))) {
    result.techStack.add('Google Apps Script');
  }

  // 6. appsscript.json (GAS manifest)
  // Check src/ subdirectory too
  if (
    (await fileExists(path.join(rootPath, 'appsscript.json'))) ||
    (await fileExists(path.join(rootPath, 'src/appsscript.json')))
  ) {
    result.techStack.add('Google Apps Script');
  }

  // 7. go.mod / Cargo.toml etc
  if (await fileExists(path.join(rootPath, 'go.mod'))) result.techStack.add('Go');
  if (await fileExists(path.join(rootPath, 'Cargo.toml'))) result.techStack.add('Rust');
  if (await fileExists(path.join(rootPath, 'pyproject.toml'))) result.techStack.add('Python');
  if (await fileExists(path.join(rootPath, 'Gemfile'))) result.techStack.add('Ruby');

  // 8. Detect languages from file extensions
  let totalLOC = 0;
  let fileCount = 0;
  const skipPatterns = [
    '**/node_modules/**',
    '**/.git/**',
    '**/dist/**',
    '**/build/**',
  ];
  for await (const filePath of walkTextFiles(rootPath, skipPatterns)) {
    fileCount++;
    const ext = path.extname(filePath).toLowerCase();
    const lang = mapExtToLanguage(ext);
    if (lang) result.languages.add(lang);
    // LOC estimate (small files only)
    try {
      const stat = await fs.stat(filePath);
      if (stat.size < 1024 * 1024) {
        const content = await fs.readFile(filePath, 'utf8');
        totalLOC += content.split('\n').length;
      }
    } catch {}
  }
  result.loc = totalLOC;
  result.fileCount = fileCount;

  // Add languages to tech stack (only if not already there)
  for (const lang of result.languages) {
    if (
      !Array.from(result.techStack).some(
        (t) => t.toLowerCase() === lang.toLowerCase() || t.toLowerCase().includes(lang.toLowerCase())
      )
    ) {
      result.techStack.add(lang);
    }
  }

  // 9. Git commit dates
  try {
    const { stdout: firstStdout } = await execFileAsync('git', [
      '-C', rootPath, 'log', '--reverse', '--format=%aI', '--max-count=1',
    ]);
    result.firstCommit = firstStdout.trim();

    const { stdout: lastStdout } = await execFileAsync('git', [
      '-C', rootPath, 'log', '--format=%aI', '--max-count=1',
    ]);
    result.lastCommit = lastStdout.trim();
  } catch {}

  // Convert Set to Array for serialization
  result.techStack = Array.from(result.techStack);
  result.languages = Array.from(result.languages);

  return result;
}

/**
 * Map an npm dependency name to a "human-friendly" tech name
 */
function mapNpmDepToTech(dep) {
  const map = {
    react: 'React',
    'react-dom': 'React',
    next: 'Next.js',
    vue: 'Vue.js',
    nuxt: 'Nuxt.js',
    svelte: 'Svelte',
    typescript: 'TypeScript',
    vite: 'Vite',
    webpack: 'Webpack',
    tailwindcss: 'Tailwind CSS',
    express: 'Express',
    fastify: 'Fastify',
    nestjs: 'NestJS',
    '@nestjs/core': 'NestJS',
    prisma: 'Prisma',
    mongoose: 'MongoDB',
    sequelize: 'PostgreSQL/MySQL',
    typeorm: 'PostgreSQL/MySQL',
    '@notionhq/client': 'Notion API',
    openai: 'OpenAI API',
    '@anthropic-ai/sdk': 'Anthropic API',
    '@google/generative-ai': 'Gemini API',
    'js-yaml': null, // helper, skip
    dotenv: null,
    nodemon: null,
    eslint: null,
    prettier: null,
  };
  if (dep in map) return map[dep];
  // Default: capitalize first letter
  return dep.length > 1 ? dep.charAt(0).toUpperCase() + dep.slice(1) : null;
}

/**
 * Map file extension to language name
 */
function mapExtToLanguage(ext) {
  const map = {
    '.js': 'JavaScript',
    '.mjs': 'JavaScript',
    '.cjs': 'JavaScript',
    '.ts': 'TypeScript',
    '.tsx': 'TypeScript',
    '.jsx': 'JavaScript',
    '.html': 'HTML',
    '.css': 'CSS',
    '.scss': 'CSS',
    '.py': 'Python',
    '.gs': 'Google Apps Script',
    '.go': 'Go',
    '.rs': 'Rust',
    '.rb': 'Ruby',
    '.java': 'Java',
    '.kt': 'Kotlin',
    '.swift': 'Swift',
    '.php': 'PHP',
  };
  return map[ext] || null;
}

/**
 * Build a context summary string suitable for injecting into a prompt
 */
export function summarizeRepo(analysis) {
  const lines = [];
  lines.push(`# Repository Analysis Summary`);
  lines.push('');
  lines.push(`## Tech detected (auto)`);
  lines.push(analysis.techStack.length > 0 ? analysis.techStack.map((t) => `- ${t}`).join('\n') : '(none detected)');
  lines.push('');
  lines.push(`## File stats`);
  lines.push(`- Total files: ${analysis.fileCount}`);
  lines.push(`- LOC estimate: ${analysis.loc}`);
  if (analysis.firstCommit) lines.push(`- First commit: ${analysis.firstCommit}`);
  if (analysis.lastCommit) lines.push(`- Last commit: ${analysis.lastCommit}`);
  lines.push('');
  if (analysis.packageInfo) {
    lines.push(`## package.json`);
    lines.push(`- name: ${analysis.packageInfo.name}`);
    lines.push(`- description: ${analysis.packageInfo.description || '(none)'}`);
    lines.push(`- dependencies: ${analysis.packageInfo.dependencies.join(', ').slice(0, 200)}`);
    lines.push('');
  }
  if (analysis.readme) {
    lines.push(`## README.md (truncated to 8000 chars)`);
    lines.push('```markdown');
    lines.push(analysis.readme.slice(0, 8000));
    lines.push('```');
    lines.push('');
  }
  if (analysis.additionalDocs.length > 0) {
    lines.push(`## Additional Documentation`);
    for (const doc of analysis.additionalDocs.slice(0, 3)) {
      lines.push(`### ${doc.name}`);
      lines.push('```markdown');
      lines.push(doc.content.slice(0, 3000));
      lines.push('```');
      lines.push('');
    }
  }
  return lines.join('\n');
}
