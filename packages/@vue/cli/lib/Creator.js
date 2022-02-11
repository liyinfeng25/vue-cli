const path = require('path')
const debug = require('debug')
const inquirer = require('inquirer')
const EventEmitter = require('events')
const Generator = require('./Generator')
const cloneDeep = require('lodash.clonedeep')
const sortObject = require('./util/sortObject')
const getVersions = require('./util/getVersions')
const PackageManager = require('./util/ProjectPackageManager')
const { clearConsole } = require('./util/clearConsole')
const PromptModuleAPI = require('./PromptModuleAPI')
const writeFileTree = require('./util/writeFileTree')
const { formatFeatures } = require('./util/features')
const loadLocalPreset = require('./util/loadLocalPreset')
const loadRemotePreset = require('./util/loadRemotePreset')
const generateReadme = require('./util/generateReadme')
const { resolvePkg, isOfficialPlugin } = require('@vue/cli-shared-utils')

const {
  defaults,
  saveOptions,
  loadOptions,
  savePreset,
  validatePreset,
  rcPath
} = require('./options')

const {
  chalk,
  execa,

  log,
  warn,
  error,

  hasGit,
  hasProjectGit,
  hasYarn,
  hasPnpm3OrLater,
  hasPnpmVersionOrLater,

  exit,
  loadModule
} = require('@vue/cli-shared-utils')

const isManualMode = answers => answers.preset === '__manual__'

// Creator继承EventEmitter，EventEmitter就是node的事件模块
module.exports = class Creator extends EventEmitter {
  constructor (name, context, promptModules) {
    super()

    this.name = name
    this.context = process.env.VUE_CLI_CONTEXT = context
    const { presetPrompt, featurePrompt } = this.resolveIntroPrompts() // 获取初始预设 preset，项目初始化时需要

    this.presetPrompt = presetPrompt    // presetPrompt list
    this.featurePrompt = featurePrompt  // promptModules 等插件配置：Babel、TypeScript、Router、Vuex 等...（初始是 []）
    this.outroPrompts = this.resolveOutroPrompts()  // 保存项目的配置文件, package.json 等文件配置

    this.injectedPrompts = []  // this.featurePrompt 对应的 Prompts
    this.promptCompleteCbs = [] // injectedPrompts 对应的回调函数

    this.afterInvokeCbs = []
    this.afterAnyInvokeCbs = []

    this.run = this.run.bind(this)
    
    /* 
      预设初始化
      1、执行 promptModules 等文件配置（router、vuex）等中的 cli.injectFeature() 函数， push 到 this.featurePrompt.choices 中
      2、执行 promptModules 等文件配置中的 cli.injectPrompt() 函数，push 到 this.injectedPrompts 中
      3、执行 promptModules 等文件配置中的  cli.onPromptComplete() 函数，push 到 this.promptCompleteCbs 中，后面会根据选择的插件选择对应配置
    */
    const promptAPI = new PromptModuleAPI(this)  // 初始化将 this 传入，promptAPI在后边可以直接访问 this 实例
    promptModules.forEach(m => m(promptAPI))
  }

  async create (cliOptions = {}, preset = null) {
    const isTestOrDebug = process.env.VUE_CLI_TEST || process.env.VUE_CLI_DEBUG
    const { run, name, context, afterInvokeCbs, afterAnyInvokeCbs } = this
    if (!preset) {
      if (cliOptions.preset) {
        // vue create foo --preset bar
        preset = await this.resolvePreset(cliOptions.preset, cliOptions.clone)
      } else if (cliOptions.default) {
        // vue create foo --default
        preset = defaults.presets['Default (Vue 3)']
      } else if (cliOptions.inlinePreset) {
        // vue create foo --inlinePreset {...}
        try {
          preset = JSON.parse(cliOptions.inlinePreset)
        } catch (e) {
          error(`CLI inline preset is not valid JSON: ${cliOptions.inlinePreset}`)
          exit(1)
        }
      } else {
        preset = await this.promptAndResolvePreset()
      }
    }
    // console.log('2 ===>', preset);
    /*
    preset：
    {
      useConfigFiles: true,
      plugins: {
        '@vue/cli-plugin-babel': {},
        '@vue/cli-plugin-router': { historyMode: true },
        '@vue/cli-service': {}
      },
      vueVersion: '2',
      cssPreprocessor: 'less'
    }
    */
    // clone before mutating
    preset = cloneDeep(preset)

    //Tag: 注入核心服务插件 @vue/cli-service 模块
    // inject core service
    preset.plugins['@vue/cli-service'] = Object.assign({
      projectName: name
    }, preset)

    if (cliOptions.bare) {
      preset.plugins['@vue/cli-service'].bare = true
    }

    // legacy support for router
    if (preset.router) {
      preset.plugins['@vue/cli-plugin-router'] = {}

      if (preset.routerHistoryMode) {
        preset.plugins['@vue/cli-plugin-router'].historyMode = true
      }
    }

    // legacy support for vuex
    if (preset.vuex) {
      preset.plugins['@vue/cli-plugin-vuex'] = {}
    }

    // console.log('packageManager ==>',  loadOptions().packageManager, hasYarn(), hasPnpm3OrLater());  // yarn true false
    // 检查 package 管理方式
    const packageManager = (
      cliOptions.packageManager ||
      loadOptions().packageManager ||
      (hasYarn() ? 'yarn' : null) ||
      (hasPnpm3OrLater() ? 'pnpm' : 'npm')
    )

    await clearConsole()
    // 创建 pm 实例，主要用于 判断版本、安装依赖等
    const pm = new PackageManager({ context, forcePackageManager: packageManager })

    //Tag: 在  ***  目录下创建项目
    log(`✨  Creating project in ${chalk.yellow(context)}.`)
    this.emit('creation', { event: 'creating' })

    // 获取最新的CLI插件版本
    // get latest CLI plugin version
    const { latestMinor } = await getVersions()

    // 确认 package.json 文件内容，将 devDependencies 依赖进行更新（以下会选择对应版本）
    // generate package.json with plugin dependencies
    const pkg = {
      name,
      version: '0.1.0',
      private: true,
      devDependencies: {},
      ...resolvePkg(context)
    }
    const deps = Object.keys(preset.plugins)
    deps.forEach(dep => {
      if (preset.plugins[dep]._isPreset) {
        return
      }

      let { version } = preset.plugins[dep]

      if (!version) {
        // 如果是官方插件 || @vue/cli-service || @vue/babel-preset-env，非 debug 情况，设置为 latestMinor对应返回值，否则是 latest（最新版本）
        if (isOfficialPlugin(dep) || dep === '@vue/cli-service' || dep === '@vue/babel-preset-env') {
          version = isTestOrDebug ? `latest` : `~${latestMinor}`
        } else {
          version = 'latest'
        }
      }
      pkg.devDependencies[dep] = version
    })
    
    // 写 package.json 文件内容
    // write package.json
    await writeFileTree(context, {
      'package.json': JSON.stringify(pkg, null, 2)
    })

    // generate a .npmrc file for pnpm, to persist the `shamefully-flatten` flag
    if (packageManager === 'pnpm') {
      const pnpmConfig = hasPnpmVersionOrLater('4.0.0')
        ? 'shamefully-hoist=true\n'
        : 'shamefully-flatten=true\n'

      await writeFileTree(context, {
        '.npmrc': pnpmConfig
      })
    }

    // intilaize git repository before installing deps
    // so that vue-cli-service can setup git hooks.
    const shouldInitGit = this.shouldInitGit(cliOptions)
    if (shouldInitGit) {
      log(`🗃  Initializing git repository...`)
      this.emit('creation', { event: 'git-init' })
      await run('git init')
    }

    //Tag: 安装 Cli 插件
    // install plugins
    log(`⚙\u{fe0f}  Installing CLI plugins. This might take a while...`)
    log()
    this.emit('creation', { event: 'plugins-install' })

    if (isTestOrDebug && !process.env.VUE_CLI_TEST_DO_INSTALL_PLUGIN) {
      // in development, avoid installation process
      await require('./util/setupDevProject')(context)
    } else {
      await pm.install()
    }

    //Tag: 生成配置
    // run generator
    log(`🚀  Invoking generators...`)
    this.emit('creation', { event: 'invoking-generators' })
    const plugins = await this.resolvePlugins(preset.plugins, pkg)
    // console.log('afterInvokeCbs', afterInvokeCbs);
    // console.log('afterAnyInvokeCbs', afterAnyInvokeCbs);

    const generator = new Generator(context, {
      pkg,
      plugins,
      afterInvokeCbs,
      afterAnyInvokeCbs
    })

    /*
    Generator {
      context: '/Users/liyinfeng/Desktop/github-liyinfeng25/demo/ff',
      plugins: [
        {
          id: '@vue/cli-service',
          apply: [Function (anonymous)],
          options: [Object]
        },
        {
          id: '@vue/cli-plugin-babel',
          apply: [Function (anonymous)],
          options: {}
        },
        {
          id: '@vue/cli-plugin-router',
          apply: [Function (anonymous)],
          options: [Object]
        },
        {
          id: '@vue/cli-plugin-vuex',
          apply: [Function (anonymous)],
          options: {}
        }
      ],
      originalPkg: {
        name: 'ff',
        version: '0.1.0',
        private: true,
        devDependencies: {
          '@vue/cli-plugin-babel': '~5.0.0-rc.2',
          '@vue/cli-plugin-router': '~5.0.0-rc.2',
          '@vue/cli-plugin-vuex': '~5.0.0-rc.2',
          '@vue/cli-service': '~5.0.0-rc.2'
        }
      },
      pkg: {
        name: 'ff',
        version: '0.1.0',
        private: true,
        devDependencies: {
          '@vue/cli-plugin-babel': '~5.0.0-rc.2',
          '@vue/cli-plugin-router': '~5.0.0-rc.2',
          '@vue/cli-plugin-vuex': '~5.0.0-rc.2',
          '@vue/cli-service': '~5.0.0-rc.2'
        }
      },
      pm: PackageManager {
        context: '/Users/liyinfeng/Desktop/github-liyinfeng25/demo/ff',
        _registries: {},
        bin: 'yarn'
      },
      imports: {},
      rootOptions: {
        projectName: 'ff',
        useConfigFiles: true,
        plugins: {
          '@vue/cli-plugin-babel': {},
          '@vue/cli-plugin-router': [Object],
          '@vue/cli-plugin-vuex': {}
        },
        vueVersion: '2'
      },
      afterInvokeCbs: [],
      afterAnyInvokeCbs: [],
      configTransforms: {},
      defaultConfigTransforms: {
        babel: ConfigTransform { fileDescriptor: [Object] },
        postcss: ConfigTransform { fileDescriptor: [Object] },
        eslintConfig: ConfigTransform { fileDescriptor: [Object] },
        jest: ConfigTransform { fileDescriptor: [Object] },
        browserslist: ConfigTransform { fileDescriptor: [Object] },
        'lint-staged': ConfigTransform { fileDescriptor: [Object] }
      },
      reservedConfigTransforms: { vue: ConfigTransform { fileDescriptor: [Object] } },
      invoking: false,
      depSources: {},
      files: {},
      fileMiddlewares: [],
      postProcessFilesCbs: [],
      exitLogs: [],
      allPlugins: [
        { id: '@vue/cli-plugin-babel', apply: [Function (anonymous)] },
        { id: '@vue/cli-plugin-router', apply: [Function (anonymous)] },
        { id: '@vue/cli-plugin-vuex', apply: [Function (anonymous)] }
      ]
    }
    */
    
    //Tag: 调用 genetator 函数，生成对应的文件
    await generator.generate({
      extractConfigFiles: preset.useConfigFiles
    })

    //Tag: 安装额外配置
    // install additional deps (injected by generators)
    log(`📦  Installing additional dependencies...`)
    this.emit('creation', { event: 'deps-install' })
    log()
    if (!isTestOrDebug || process.env.VUE_CLI_TEST_DO_INSTALL_PLUGIN) {
      await pm.install()
    }

    //Tag: 依赖安装之后，执行对应的回调函数
    // run complete cbs if any (injected by generators)
    log(`⚓  Running completion hooks...`)
    this.emit('creation', { event: 'completion-hooks' })
    for (const cb of afterInvokeCbs) {
      await cb()
    }
    for (const cb of afterAnyInvokeCbs) {
      await cb()
    }

    //Tag: 生成 README.md 文件
    if (!generator.files['README.md']) {
      log()
      log('📄  Generating README.md...')
      await writeFileTree(context, {
        'README.md': generateReadme(generator.pkg, packageManager)
      })
    }

    // commit initial state
    let gitCommitFailed = false
    if (shouldInitGit) {
      await run('git add -A')
      if (isTestOrDebug) {
        await run('git', ['config', 'user.name', 'test'])
        await run('git', ['config', 'user.email', 'test@test.com'])
        await run('git', ['config', 'commit.gpgSign', 'false'])
      }
      const msg = typeof cliOptions.git === 'string' ? cliOptions.git : 'init'
      try {
        await run('git', ['commit', '-m', msg, '--no-verify'])
      } catch (e) {
        gitCommitFailed = true
      }
    }

    //Tag: 构建项目文件成功提示，展示快速开始命令
    log()
    log(`🎉  Successfully created project ${chalk.yellow(name)}.`)
    if (!cliOptions.skipGetStarted) {
      // 快速开始命令
      log(
        `👉  Get started with the following commands:\n\n` +
        (this.context === process.cwd() ? `` : chalk.cyan(` ${chalk.gray('$')} cd ${name}\n`)) +
        chalk.cyan(` ${chalk.gray('$')} ${packageManager === 'yarn' ? 'yarn serve' : packageManager === 'pnpm' ? 'pnpm run serve' : 'npm run serve'}`)
      )
    }
    log()
    this.emit('creation', { event: 'done' })

    if (gitCommitFailed) {
      warn(
        `Skipped git commit due to missing username and email in git config, or failed to sign commit.\n` +
        `You will need to perform the initial commit yourself.\n`
      )
    }

    generator.printExitLogs()
  }

  run (command, args) {
    if (!args) { [command, ...args] = command.split(/\s+/) }
    return execa(command, args, { cwd: this.context })
  }

  // 利用 inquirer.prompt 使用交互式形式获取 preset
  async promptAndResolvePreset (answers = null) {
    // prompt
    if (!answers) {
      await clearConsole(true)
      answers = await inquirer.prompt(this.resolveFinalPrompts())
    }
    debug('vue-cli:answers')(answers)

    // console.log('answers ===>', answers);
    /*
    answers ===> 
    {
      preset: '__manual__',
      features: [ 'router', 'vuex', 'css-preprocessor', 'linter' ],
      vueVersion: '2',
      historyMode: true,
      cssPreprocessor: 'less',
      eslintConfig: 'base',
      lintOn: [ 'save' ],
      useConfigFiles: 'files',
      save: false
    }
    */

    if (answers.packageManager) {
      saveOptions({
        packageManager: answers.packageManager
      })
    }

    let preset
    if (answers.preset && answers.preset !== '__manual__') {
      preset = await this.resolvePreset(answers.preset)
    } else {
      // manual
      preset = {
        useConfigFiles: answers.useConfigFiles === 'files',
        plugins: {}
      }
      answers.features = answers.features || []
      // run cb registered by prompt modules to finalize the preset
      this.promptCompleteCbs.forEach(cb => cb(answers, preset))
    }

    // validate
    validatePreset(preset)

    // save preset
    if (answers.save && answers.saveName && savePreset(answers.saveName, preset)) {
      log()
      log(`🎉  Preset ${chalk.yellow(answers.saveName)} saved in ${chalk.yellow(rcPath)}`)
    }

    debug('vue-cli:preset')(preset)
    return preset
  }

  async resolvePreset (name, clone) {
    let preset
    const savedPresets = this.getPresets()

    if (name in savedPresets) {
      preset = savedPresets[name]
    } else if (name === 'default') {
      preset = savedPresets['Default (Vue 3)']
    } else if (name.endsWith('.json') || /^\./.test(name) || path.isAbsolute(name)) {
      preset = await loadLocalPreset(path.resolve(name))
    } else if (name.includes('/')) {
      log(`Fetching remote preset ${chalk.cyan(name)}...`)
      this.emit('creation', { event: 'fetch-remote-preset' })
      try {
        preset = await loadRemotePreset(name, clone)
      } catch (e) {
        error(`Failed fetching remote preset ${chalk.cyan(name)}:`)
        throw e
      }
    }

    if (!preset) {
      error(`preset "${name}" not found.`)
      const presets = Object.keys(savedPresets)
      if (presets.length) {
        log()
        log(`available presets:\n${presets.join(`\n`)}`)
      } else {
        log(`you don't seem to have any saved preset.`)
        log(`run vue-cli in manual mode to create a preset.`)
      }
      exit(1)
    }
    return preset
  }

  // 加载每个插件的 generator 函数
  // { id: options } => [{ id, apply, options }]
  async resolvePlugins (rawPlugins, pkg) {
    console.log('rawPlugins ==>', rawPlugins);
    // ensure cli-service is invoked first
    rawPlugins = sortObject(rawPlugins, ['@vue/cli-service'], true)
    const plugins = []
    for (const id of Object.keys(rawPlugins)) {
      const apply = loadModule(`${id}/generator`, this.context) || (() => {})
      let options = rawPlugins[id] || {}
      console.log('options ==>', options);

      if (options.prompts) {
        let pluginPrompts = loadModule(`${id}/prompts`, this.context)

        if (pluginPrompts) {
          const prompt = inquirer.createPromptModule()

          if (typeof pluginPrompts === 'function') {
            pluginPrompts = pluginPrompts(pkg, prompt)
          }
          if (typeof pluginPrompts.getPrompts === 'function') {
            pluginPrompts = pluginPrompts.getPrompts(pkg, prompt)
          }

          log()
          log(`${chalk.cyan(options._isPreset ? `Preset options:` : id)}`)
          options = await prompt(pluginPrompts)
        }
      }

      plugins.push({ id, apply, options })
    }
    console.log('plugins ==>', plugins);
    return plugins
  }
  
  // 默认预设及相关插件
  getPresets () {
    const savedOptions = loadOptions()
    return Object.assign({}, savedOptions.presets, defaults.presets)
  }
  
  // 获取默认预设及插件
  resolveIntroPrompts () {
    const presets = this.getPresets()
    /*
    {
      'Default (Vue 3)': {
        vueVersion: '3',
        useConfigFiles: false,
        cssPreprocessor: undefined,
        plugins: { '@vue/cli-plugin-babel': {}, '@vue/cli-plugin-eslint': [Object] }
      },
      'Default (Vue 2)': {
        vueVersion: '2',
        useConfigFiles: false,
        cssPreprocessor: undefined,
        plugins: { '@vue/cli-plugin-babel': {}, '@vue/cli-plugin-eslint': [Object] }
      }
    } 
    */
    const presetChoices = Object.entries(presets).map(([name, preset]) => {
      let displayName = name
      // Vue version will be showed as features anyway,
      // so we shouldn't display it twice.
      if (name === 'Default (Vue 2)' || name === 'Default (Vue 3)') {
        displayName = 'Default'
      }

      return {
        name: `${displayName} (${formatFeatures(preset)})`,
        value: name
      }
    })
    const presetPrompt = {
      name: 'preset',
      type: 'list',
      message: `Please pick a preset:`,
      choices: [
        ...presetChoices,
        {
          name: 'Manually select features',
          value: '__manual__'
        }
      ]
    }
    const featurePrompt = {
      name: 'features',
      when: isManualMode,
      type: 'checkbox',
      message: 'Check the features needed for your project:',
      choices: [],
      pageSize: 10
    }
    return {
      presetPrompt,
      featurePrompt
    }
  }
  
  // 初始化项目配置文件
  resolveOutroPrompts () {
    const outroPrompts = [
      {
        name: 'useConfigFiles',
        when: isManualMode,
        type: 'list',
        message: 'Where do you prefer placing config for Babel, ESLint, etc.?',
        choices: [
          {
            name: 'In dedicated config files',
            value: 'files'
          },
          {
            name: 'In package.json',
            value: 'pkg'
          }
        ]
      },
      {
        name: 'save',
        when: isManualMode,
        type: 'confirm',
        message: 'Save this as a preset for future projects?',
        default: false
      },
      {
        name: 'saveName',
        when: answers => answers.save,
        type: 'input',
        message: 'Save preset as:'
      }
    ]

    // ask for packageManager once
    const savedOptions = loadOptions()
    if (!savedOptions.packageManager && (hasYarn() || hasPnpm3OrLater())) {
      const packageManagerChoices = []

      if (hasYarn()) {
        packageManagerChoices.push({
          name: 'Use Yarn',
          value: 'yarn',
          short: 'Yarn'
        })
      }

      if (hasPnpm3OrLater()) {
        packageManagerChoices.push({
          name: 'Use PNPM',
          value: 'pnpm',
          short: 'PNPM'
        })
      }

      packageManagerChoices.push({
        name: 'Use NPM',
        value: 'npm',
        short: 'NPM'
      })

      outroPrompts.push({
        name: 'packageManager',
        type: 'list',
        message: 'Pick the package manager to use when installing dependencies:',
        choices: packageManagerChoices
      })
    }

    return outroPrompts
  }
  
  // 合并返回最终输入提示
  resolveFinalPrompts () {
    /*
    this.presetPrompt  

    {
      name: 'preset',
      type: 'list',
      message: 'Please pick a preset:',
      choices: [
        {
          name: 'Default (\x1B[33m[Vue 3] \x1B[39m\x1B[33mbabel\x1B[39m, \x1B[33meslint\x1B[39m)',
          value: 'Default (Vue 3)'
        },
        {
          name: 'Default (\x1B[33m[Vue 2] \x1B[39m\x1B[33mbabel\x1B[39m, \x1B[33meslint\x1B[39m)',
          value: 'Default (Vue 2)'
        },
        { name: 'Manually select features', value: '__manual__' }
      ]
    }
    */


    /*
    this.featurePrompt  

    {
      name: 'features',
      when: [Function: isManualMode],
      type: 'checkbox',
      message: 'Check the features needed for your project:',
      choices: [
        {
          name: 'Babel',
          value: 'babel',
          short: 'Babel',
          description: 'Transpile modern JavaScript to older versions (for compatibility)',
          link: 'https://babeljs.io/',
          checked: true
        },
        {
          name: 'TypeScript',
          value: 'ts',
          short: 'TS',
          description: 'Add support for the TypeScript language',
          link: 'https://github.com/vuejs/vue-cli/tree/dev/packages/%40vue/cli-plugin-typescript',
          plugins: [Array]
        },
        {
          name: 'Progressive Web App (PWA) Support',
          value: 'pwa',
          short: 'PWA',
          description: 'Improve performances with features like Web manifest and Service workers',
          link: 'https://github.com/vuejs/vue-cli/tree/dev/packages/%40vue/cli-plugin-pwa'
        },
        {
          name: 'Router',
          value: 'router',
          description: 'Structure the app with dynamic pages',
          link: 'https://router.vuejs.org/'
        },
        {
          name: 'Vuex',
          value: 'vuex',
          description: 'Manage the app state with a centralized store',
          link: 'https://vuex.vuejs.org/'
        },
        {
          name: 'CSS Pre-processors',
          value: 'css-preprocessor',
          description: 'Add support for CSS pre-processors like Sass, Less or Stylus',
          link: 'https://cli.vuejs.org/guide/css.html'
        },
        {
          name: 'Linter / Formatter',
          value: 'linter',
          short: 'Linter',
          description: 'Check and enforce code quality with ESLint or Prettier',
          link: 'https://github.com/vuejs/vue-cli/tree/dev/packages/%40vue/cli-plugin-eslint',
          plugins: [Array],
          checked: true
        },
        {
          name: 'Unit Testing',
          value: 'unit',
          short: 'Unit',
          description: 'Add a Unit Testing solution like Jest or Mocha',
          link: 'https://cli.vuejs.org/config/#unit-testing',
          plugins: [Array]
        },
        {
          name: 'E2E Testing',
          value: 'e2e',
          short: 'E2E',
          description: 'Add an End-to-End testing solution to the app like Cypress or Nightwatch',
          link: 'https://github.com/vuejs/vue-cli/tree/dev/docs#e2e-testing',
          plugins: [Array]
        }
      ],
      pageSize: 10
    }
    */

    /*
    this.injectedPrompts
    [
      {
        name: 'vueVersion',
        message: 'Choose a version of Vue.js that you want to start the project with',
        type: 'list',
        choices: [ [Object], [Object] ],
        default: '3'
      },
      {
        name: 'tsClassComponent',
        when: [Function: when],
        type: 'confirm',
        message: 'Use class-style component syntax?',
        description: 'Use the @Component decorator on classes.',
        link: 'https://vuejs.org/v2/guide/typescript.html#Class-Style-Vue-Components',
        default: [Function: default]
      },
      {
        name: 'useTsWithBabel',
        when: [Function: when],
        type: 'confirm',
        message: 'Use Babel alongside TypeScript (required for modern mode, auto-detected polyfills, transpiling JSX)?',
        description: 'It will output ES2015 and delegate the rest to Babel for auto polyfill based on browser targets.',
        default: [Function: default]
      },
      {
        name: 'historyMode',
        when: [Function: when],
        type: 'confirm',
        message: 'Use history mode for router? \x1B[33m(Requires proper server setup for index fallback in production)\x1B[39m',
        description: "By using the HTML5 History API, the URLs don't need the '#' character anymore.",
        link: 'https://router.vuejs.org/guide/essentials/history-mode.html'
      },
      {
        name: 'cssPreprocessor',
        when: [Function: when],
        type: 'list',
        message: 'Pick a CSS pre-processor (PostCSS, Autoprefixer and CSS Modules are supported by default):',
        description: 'PostCSS, Autoprefixer and CSS Modules are supported by default.',
        choices: [ [Object], [Object], [Object] ]
      },
      {
        name: 'eslintConfig',
        when: [Function: when],
        type: 'list',
        message: 'Pick a linter / formatter config:',
        description: 'Checking code errors and enforcing an homogeoneous code style is recommended.',
        choices: [Function: choices]
      },
      {
        name: 'lintOn',
        message: 'Pick additional lint features:',
        when: [Function: when],
        type: 'checkbox',
        choices: [ [Object], [Object] ]
      },
      {
        name: 'unit',
        when: [Function: when],
        type: 'list',
        message: 'Pick a unit testing solution:',
        choices: [ [Object], [Object] ]
      },
      {
        name: 'e2e',
        when: [Function: when],
        type: 'list',
        message: 'Pick an E2E testing solution:',
        choices: [ [Object], [Object], [Object] ]
      },
      {
        name: 'webdrivers',
        when: [Function: when],
        type: 'checkbox',
        message: 'Pick browsers to run end-to-end test on',
        choices: [ [Object], [Object] ]
      }
    ]
    */

    /*
    this.outroPrompts

    [
      {
        name: 'useConfigFiles',
        when: [Function: isManualMode],
        type: 'list',
        message: 'Where do you prefer placing config for Babel, ESLint, etc.?',
        choices: [ [Object], [Object] ]
      },
      {
        name: 'save',
        when: [Function: isManualMode],
        type: 'confirm',
        message: 'Save this as a preset for future projects?',
        default: false
      },
      {
        name: 'saveName',
        when: [Function: when],
        type: 'input',
        message: 'Save preset as:'
      }
    ]
    */
    // patch generator-injected prompts to only show in manual mode
    this.injectedPrompts.forEach(prompt => {
      // 如果 prompt 有对应的 when 条件，使用自己条件，否则设置为true
      const originalWhen = prompt.when || (() => true)
      // 返回 when 条件为：为自定义选项 && originalWhen 条件为真
      prompt.when = answers => {
        return isManualMode(answers) && originalWhen(answers)
      }
    })

    const prompts = [
      this.presetPrompt,
      this.featurePrompt,
      ...this.injectedPrompts,
      ...this.outroPrompts
    ]
    debug('vue-cli:prompts')(prompts)

    // console.log('prompts ===>', prompts);

    /*
    [
      {
        name: 'preset',
        type: 'list',
        message: 'Please pick a preset:',
        choices: [ [Object], [Object], [Object] ]
      },
      {
        name: 'features',
        when: [Function: isManualMode],
        type: 'checkbox',
        message: 'Check the features needed for your project:',
        choices: [
          [Object], [Object],
          [Object], [Object],
          [Object], [Object],
          [Object], [Object],
          [Object]
        ],
        pageSize: 10
      },
      {
        name: 'vueVersion',
        message: 'Choose a version of Vue.js that you want to start the project with',
        type: 'list',
        choices: [ [Object], [Object] ],
        default: '3',
        when: [Function (anonymous)]
      },
      {
        name: 'tsClassComponent',
        when: [Function (anonymous)],
        type: 'confirm',
        message: 'Use class-style component syntax?',
        description: 'Use the @Component decorator on classes.',
        link: 'https://vuejs.org/v2/guide/typescript.html#Class-Style-Vue-Components',
        default: [Function: default]
      },
      {
        name: 'useTsWithBabel',
        when: [Function (anonymous)],
        type: 'confirm',
        message: 'Use Babel alongside TypeScript (required for modern mode, auto-detected polyfills, transpiling JSX)?',
        description: 'It will output ES2015 and delegate the rest to Babel for auto polyfill based on browser targets.',
        default: [Function: default]
      },
      {
        name: 'historyMode',
        when: [Function (anonymous)],
        type: 'confirm',
        message: 'Use history mode for router? \x1B[33m(Requires proper server setup for index fallback in production)\x1B[39m',
        description: "By using the HTML5 History API, the URLs don't need the '#' character anymore.",
        link: 'https://router.vuejs.org/guide/essentials/history-mode.html'
      },
      {
        name: 'cssPreprocessor',
        when: [Function (anonymous)],
        type: 'list',
        message: 'Pick a CSS pre-processor (PostCSS, Autoprefixer and CSS Modules are supported by default):',
        description: 'PostCSS, Autoprefixer and CSS Modules are supported by default.',
        choices: [ [Object], [Object], [Object] ]
      },
      {
        name: 'eslintConfig',
        when: [Function (anonymous)],
        type: 'list',
        message: 'Pick a linter / formatter config:',
        description: 'Checking code errors and enforcing an homogeoneous code style is recommended.',
        choices: [Function: choices]
      },
      {
        name: 'lintOn',
        message: 'Pick additional lint features:',
        when: [Function (anonymous)],
        type: 'checkbox',
        choices: [ [Object], [Object] ]
      },
      {
        name: 'unit',
        when: [Function (anonymous)],
        type: 'list',
        message: 'Pick a unit testing solution:',
        choices: [ [Object], [Object] ]
      },
      {
        name: 'e2e',
        when: [Function (anonymous)],
        type: 'list',
        message: 'Pick an E2E testing solution:',
        choices: [ [Object], [Object], [Object] ]
      },
      {
        name: 'webdrivers',
        when: [Function (anonymous)],
        type: 'checkbox',
        message: 'Pick browsers to run end-to-end test on',
        choices: [ [Object], [Object] ]
      },
      {
        name: 'useConfigFiles',
        when: [Function: isManualMode],
        type: 'list',
        message: 'Where do you prefer placing config for Babel, ESLint, etc.?',
        choices: [ [Object], [Object] ]
      },
      {
        name: 'save',
        when: [Function: isManualMode],
        type: 'confirm',
        message: 'Save this as a preset for future projects?',
        default: false
      },
      {
        name: 'saveName',
        when: [Function: when],
        type: 'input',
        message: 'Save preset as:'
      }
    ]
    */
    return prompts
  }

  shouldInitGit (cliOptions) {
    if (!hasGit()) {
      return false
    }
    // --git
    if (cliOptions.forceGit) {
      return true
    }
    // --no-git
    if (cliOptions.git === false || cliOptions.git === 'false') {
      return false
    }
    // default: true unless already in a git repo
    return !hasProjectGit(this.context)
  }
}
