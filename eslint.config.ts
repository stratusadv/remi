import javascript from '@eslint/js'
import stylistic from '@stylistic/eslint-plugin'
import { defineConfig } from 'eslint/config'
import vue from 'eslint-plugin-vue'
import typescript from 'typescript-eslint'


const STATEMENTS_BLOCK = Object.freeze(['multiline-block-like'])
const STATEMENTS_DECLARATION = Object.freeze(['const', 'let'])

const STATEMENTS_MULTILINE = Object.freeze([
    'multiline-const',
    'multiline-expression',
    'multiline-let',
])


export default defineConfig(
    {
        ignores: [
            '.venv/**',
            'design/**',
            'dist/**',
            'node_modules/**',
            'public/**',
            'server/**',
            'site/**',
            'src-tauri/**',
        ],
    },
    {
        files: ['**/*.ts', '**/*.vue'],
        extends: [
            javascript.configs.recommended,
            typescript.configs.strictTypeChecked,
            typescript.configs.stylisticTypeChecked,
            vue.configs['flat/recommended'],
            stylistic.configs.customize({
                arrowParens: true,
                blockSpacing: true,
                braceStyle: '1tbs',
                commaDangle: 'always-multiline',
                indent: 4,
                quoteProps: 'as-needed',
                quotes: 'single',
                semi: false,
            }),
        ],
        languageOptions: {
            parserOptions: {
                extraFileExtensions: ['.vue'],
                parser: typescript.parser,
                projectService: true,
                tsconfigRootDir: import.meta.dirname,
            },
        },
        rules: {
            '@stylistic/array-bracket-newline': ['error', 'consistent'],
            '@stylistic/array-element-newline': ['error', 'consistent'],
            '@stylistic/function-call-argument-newline': ['error', 'consistent'],
            '@stylistic/function-paren-newline': ['error', 'multiline-arguments'],
            '@stylistic/linebreak-style': ['error', 'unix'],
            '@stylistic/max-len': [
                'error',
                {
                    code: 100,
                    ignoreUrls: true,
                },
            ],
            '@stylistic/no-multiple-empty-lines': [
                'error',
                {
                    max: 2,
                    maxBOF: 0,
                    maxEOF: 0,
                },
            ],
            '@stylistic/object-curly-newline': [
                'error',
                {
                    consistent: true,
                },
            ],
            '@stylistic/object-property-newline': [
                'error',
                {
                    allowAllPropertiesOnSameLine: true,
                },
            ],
            '@stylistic/operator-linebreak': [
                'error',
                'before',
                {
                    overrides: {
                        '=': 'after',
                    },
                },
            ],
            '@stylistic/padded-blocks': ['error', 'never'],
            '@stylistic/padding-line-between-statements': [
                'error',
                { blankLine: 'always', prev: '*', next: 'return' },
                { blankLine: 'any', prev: [...STATEMENTS_DECLARATION, 'if'], next: 'return' },
                { blankLine: 'always', prev: STATEMENTS_DECLARATION, next: 'expression' },
                { blankLine: 'always', prev: '*', next: STATEMENTS_BLOCK },
                { blankLine: 'always', prev: STATEMENTS_BLOCK, next: '*' },
                { blankLine: 'always', prev: '*', next: STATEMENTS_MULTILINE },
                { blankLine: 'always', prev: STATEMENTS_MULTILINE, next: '*' },
            ],
            '@typescript-eslint/consistent-type-exports': 'error',
            '@typescript-eslint/consistent-type-imports': 'error',
            '@typescript-eslint/default-param-last': 'error',
            '@typescript-eslint/explicit-function-return-type': [
                'error',
                {
                    allowExpressions: true,
                    allowTypedFunctionExpressions: true,
                },
            ],
            '@typescript-eslint/init-declarations': 'error',
            '@typescript-eslint/max-params': [
                'error',
                {
                    max: 7,
                },
            ],
            '@typescript-eslint/method-signature-style': 'error',
            '@typescript-eslint/naming-convention': [
                'error',
                {
                    selector: 'default',
                    format: ['snake_case'],
                    leadingUnderscore: 'forbid',
                    trailingUnderscore: 'forbid',
                },
                {
                    selector: 'import',
                    format: null,
                },
                {
                    selector: 'variable',
                    format: ['snake_case', 'UPPER_CASE'],
                },
                {
                    selector: 'variable',
                    modifiers: ['destructured'],
                    format: null,
                },
                {
                    selector: 'objectLiteralMethod',
                    format: null,
                },
                {
                    selector: 'objectLiteralProperty',
                    format: null,
                },
                {
                    selector: 'typeLike',
                    format: ['PascalCase'],
                },
                {
                    selector: 'typeParameter',
                    format: ['PascalCase'],
                    custom: {
                        regex: '^[A-Z][a-z]+',
                        match: true,
                    },
                },
                {
                    selector: 'enumMember',
                    format: ['PascalCase'],
                },
            ],
            '@typescript-eslint/no-import-type-side-effects': 'error',
            '@typescript-eslint/no-loop-func': 'error',
            '@typescript-eslint/no-shadow': 'error',
            '@typescript-eslint/no-unnecessary-qualifier': 'error',
            '@typescript-eslint/no-unsafe-type-assertion': 'error',
            '@typescript-eslint/no-useless-empty-export': 'error',
            '@typescript-eslint/prefer-readonly': 'error',
            '@typescript-eslint/promise-function-async': 'error',
            '@typescript-eslint/require-array-sort-compare': 'error',
            '@typescript-eslint/strict-boolean-expressions': [
                'error',
                {
                    allowNullableObject: false,
                    allowNumber: false,
                    allowString: false,
                },
            ],
            '@typescript-eslint/switch-exhaustiveness-check': [
                'error',
                {
                    considerDefaultExhaustiveForUnions: false,
                    requireDefaultForNonUnion: true,
                },
            ],
            'array-callback-return': 'error',
            curly: ['error', 'multi-line', 'consistent'],
            'default-case-last': 'error',
            eqeqeq: ['error', 'always'],
            'func-style': ['error', 'declaration'],
            'id-length': [
                'error',
                {
                    min: 2,
                    properties: 'never',
                },
            ],
            'max-depth': ['error', 4],
            'max-lines-per-function': [
                'error',
                {
                    max: 70,
                    skipComments: true,
                },
            ],
            'no-alert': 'error',
            'no-await-in-loop': 'error',
            'no-console': 'error',
            'no-undef': 'off',
            'no-implicit-coercion': 'error',
            'no-labels': 'error',
            'no-lone-blocks': 'error',
            'no-multi-assign': 'error',
            'no-nested-ternary': 'error',
            'no-param-reassign': [
                'error',
                {
                    props: true,
                },
            ],
            'no-promise-executor-return': 'error',
            'no-restricted-syntax': [
                'error',
                {
                    selector: 'IfStatement > IfStatement.alternate:not([alternate])',
                    message: 'An if and else-if chain ends in else.',
                },
                {
                    selector: 'ForInStatement',
                    message: 'Iterate Object.keys or Object.entries rather than for-in.',
                },
                {
                    selector: 'SequenceExpression',
                    message: 'Write one expression per statement.',
                },
            ],
            'no-return-assign': 'error',
            'no-self-compare': 'error',
            'no-sequences': 'error',
            'no-template-curly-in-string': 'error',
            'no-unmodified-loop-condition': 'error',
            'no-unreachable-loop': 'error',
            'no-useless-assignment': 'error',
            'no-useless-concat': 'error',
            'no-useless-return': 'error',
            'no-void': [
                'error',
                {
                    allowAsStatement: true,
                },
            ],
            'object-shorthand': 'error',
            'operator-assignment': 'error',
            'prefer-object-spread': 'error',
            'prefer-template': 'error',
            radix: 'error',
            'require-atomic-updates': 'error',
            yoda: 'error',
        },
    },
    {
        files: ['**/*.vue'],
        rules: {
            '@stylistic/indent': 'off',
            'vue/block-lang': [
                'error',
                {
                    script: {
                        lang: 'ts',
                    },
                },
            ],
            'vue/component-api-style': ['error', ['script-setup']],
            'vue/define-emits-declaration': ['error', 'type-literal'],
            'vue/define-macros-order': 'error',
            'vue/define-props-declaration': ['error', 'type-based'],
            'vue/html-indent': ['error', 4],
            'vue/max-attributes-per-line': [
                'error',
                {
                    multiline: 1,
                    singleline: 100,
                },
            ],
            'vue/multi-word-component-names': [
                'error',
                {
                    ignores: ['app'],
                },
            ],
            'vue/no-boolean-default': 'error',
            'vue/no-ref-object-reactivity-loss': 'error',
            'vue/no-required-prop-with-default': 'error',
            'vue/no-undef-components': 'error',
            'vue/no-undef-properties': 'error',
            'vue/no-unused-emit-declarations': 'error',
            'vue/no-unused-properties': 'error',
            'vue/no-unused-refs': 'error',
            'vue/no-useless-mustaches': 'error',
            'vue/no-useless-v-bind': 'error',
            'vue/padding-line-between-blocks': 'error',
            'vue/prefer-true-attribute-shorthand': 'error',
            'vue/prop-name-casing': ['error', 'snake_case'],
            'vue/require-macro-variable-name': 'error',
            'vue/require-typed-ref': 'error',
            'vue/script-indent': [
                'error',
                4,
                {
                    baseIndent: 0,
                    switchCase: 1,
                },
            ],
            'vue/singleline-html-element-content-newline': 'off',
        },
    },
)
