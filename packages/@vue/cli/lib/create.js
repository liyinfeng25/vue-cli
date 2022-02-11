const fs = require('fs-extra')
const path = require('path')
const inquirer = require('inquirer')
const Creator = require('./Creator')
const { clearConsole } = require('./util/clearConsole')
const { getPromptModules } = require('./util/createTools')
const { chalk, error, stopSpinner, exit } = require('@vue/cli-shared-utils')
const validateProjectName = require('validate-npm-package-name')

async function create (projectName, options) {
  if (options.proxy) {
    process.env.HTTP_PROXY = options.proxy
  }

  // 运行脚手架所在的目录
  const cwd = options.cwd || process.cwd()
  // 当前项目名称为 .，代表在当前目录，不需要创建新的文件夹
  const inCurrent = projectName === '.'
  // 条件为真，文件夹名称为当前目录名称，否则是传入的变量
  const name = inCurrent ? path.relative('../', cwd) : projectName
  // 创建文件夹所在的目录：/Users/liyinfeng/Desktop/github-liyinfeng25/demo、/Users/liyinfeng/Desktop/github-liyinfeng25/demo/ff
  const targetDir = path.resolve(cwd, projectName || '.')

  // Tag: 文件夹名称校验：空格、特殊符号、文件夹名称长度等
  const result = validateProjectName(name)
  if (!result.validForNewPackages) {
    console.error(chalk.red(`Invalid project name: "${name}"`))
    result.errors && result.errors.forEach(err => {
      console.error(chalk.red.dim('Error: ' + err))
    })
    result.warnings && result.warnings.forEach(warn => {
      console.error(chalk.red.dim('Warning: ' + warn))
    })
    exit(1)
  }
  
  //Tag: step1：当目录存在时，进行以下校验，是删除还是覆盖
  if (fs.existsSync(targetDir) && !options.merge) {
    //1、是否强制删除同名文件夹，是：直接删除当前文件夹即可
    if (options.force) {
      await fs.remove(targetDir)
    } else {
      await clearConsole()
      //2、是根目录的话，使用户进行确认
      if (inCurrent) {
        const { ok } = await inquirer.prompt([
          {
            name: 'ok',
            type: 'confirm',
            message: `Generate project in current directory?`
          }
        ])
        if (!ok) {
          return
        }
      } else {
        //3、存在同名文件夹，使用户进行确认是：重写、合并、关闭
        const { action } = await inquirer.prompt([
          {
            name: 'action',
            type: 'list',
            message: `Target directory ${chalk.cyan(targetDir)} already exists. Pick an action:`,
            choices: [
              { name: 'Overwrite', value: 'overwrite' },
              { name: 'Merge', value: 'merge' },
              { name: 'Cancel', value: false }
            ]
          }
        ])
        if (!action) {
          return
        } else if (action === 'overwrite') {
          console.log(`\nRemoving ${chalk.cyan(targetDir)}...`)
          await fs.remove(targetDir)
        }
      }
    }
  }

  // Tag: step2： 创建项目核心方法
  /**
   * name: 项目名
   * targetDir: 目录地址
   * getPromptModules(): 获取自定义模板时，预设选项列表： babel、vuex、vueRouter 等模块
   * 
   */
  const creator = new Creator(name, targetDir, getPromptModules())
  console.log('options==>', options);
  await creator.create(options)
}

module.exports = (...args) => {
  return create(...args).catch(err => {
    stopSpinner(false) // do not persist
    error(err)
    if (!process.env.VUE_CLI_TEST) {
      process.exit(1)
    }
  })
}
