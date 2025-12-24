import { Contract } from '@algorandfoundation/algorand-typescript'

export class AbelStub extends Contract {
  hello(name: string): string {
    return `Hello, ${name}`
  }
}
